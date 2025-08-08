import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, setDoc, getDocs, collection, query, addDoc } from 'firebase/firestore';
import { Camera, Phone, Copy } from 'lucide-react';

// Tailwind CSS is assumed to be available
// Ensure you have a 'lucide-react' installed or use inline SVGs
const App = () => {
  // Use state to manage the app's internal data
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callId, setCallId] = useState('');
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // useRef is used to store references to the video elements and the RTCPeerConnection object
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const pc = useRef(null);

  // Firebase initialization and authentication
  const db = useRef(null);
  const auth = useRef(null);
  
  useEffect(() => {
    // This effect runs once to initialize Firebase and handle user authentication
    const setupFirebase = async () => {
      try {
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
        const firebaseApp = initializeApp(firebaseConfig, appId);
        db.current = getFirestore(firebaseApp);
        auth.current = getAuth(firebaseApp);

        // Sign in with the custom token or anonymously if not available
        if (typeof __initial_auth_token !== 'undefined') {
          await signInWithCustomToken(auth.current, __initial_auth_token);
        } else {
          await signInAnonymously(auth.current);
        }

        // Listen for authentication state changes
        const unsubscribe = onAuthStateChanged(auth.current, (user) => {
          if (user) {
            setUserId(user.uid);
          } else {
            setUserId(crypto.randomUUID()); // Use a random ID if not authenticated
          }
          setIsAuthReady(true);
        });

        return () => unsubscribe();
      } catch (error) {
        console.error("Error setting up Firebase:", error);
      }
    };
    setupFirebase();
  }, []);

  // Effect to handle the remote stream
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);
  
  // Effect to handle the local stream
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Function to get access to the camera and microphone
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
    } catch (err) {
      console.error("Error accessing media devices:", err);
      // Use a custom UI element instead of alert()
      // You can add a state variable to control a modal here
    }
  };

  // Helper function to create the RTCPeerConnection
  const createPeerConnection = () => {
    const iceServers = {
      iceServers: [
        {
          urls: 'stun:stun.l.google.com:19302'
        },
      ],
    };

    const newPc = new RTCPeerConnection(iceServers);
    pc.current = newPc;

    // Listen for ICE candidates and save them to Firestore
    newPc.onicecandidate = async (event) => {
      if (event.candidate) {
        console.log("Found ICE candidate:", event.candidate);
        const candidatesCollectionRef = collection(db.current, `artifacts/${__app_id}/public/data/calls/${callId}/candidates`);
        await addDoc(candidatesCollectionRef, event.candidate.toJSON());
      }
    };

    // Listen for the remote stream
    newPc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };
    
    // Add all local tracks to the peer connection
    localStream.getTracks().forEach((track) => {
      newPc.addTrack(track, localStream);
    });

    return newPc;
  };

  // Function for the 'caller' to create a new call
  const createCall = async () => {
    if (!db.current || !localStream) {
      console.error("Firebase not initialized or no local stream.");
      return;
    }

    const newCallId = Math.floor(Math.random() * 1000000).toString();
    setCallId(newCallId);
    
    const callsCollectionRef = collection(db.current, `artifacts/${__app_id}/public/data/calls`);
    const newCallDocRef = doc(callsCollectionRef, newCallId);

    const newPc = createPeerConnection();

    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    // Save the offer to Firestore
    await setDoc(newCallDocRef, { offer: { ...offer.toJSON() } });
    console.log(`Call created with ID: ${newCallId}`);

    // Listen for the answer from the 'callee'
    onSnapshot(newCallDocRef, async (snapshot) => {
      const data = snapshot.data();
      if (data?.answer && !newPc.currentRemoteDescription) {
        console.log("Received answer:", data.answer);
        const answerDescription = new RTCSessionDescription(data.answer);
        await newPc.setRemoteDescription(answerDescription);
      }
    });

    // Listen for ICE candidates from the 'callee' and add them to the connection
    onSnapshot(collection(db.current, `artifacts/${__app_id}/public/data/calls/${newCallId}/answerCandidates`), async (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          newPc.addIceCandidate(candidate);
        }
      });
    });
  };

  // Function for the 'callee' to answer a call
  const answerCall = async () => {
    if (!db.current || !localStream || !callId) {
      console.error("Firebase not initialized, no local stream, or no call ID.");
      return;
    }

    const newPc = createPeerConnection();

    // Get the offer from Firestore
    const callDocRef = doc(db.current, `artifacts/${__app_id}/public/data/calls/${callId}`);
    const callSnapshot = await getDocs(query(collection(db.current, `artifacts/${__app_id}/public/data/calls`)));

    // Check if the call exists
    const callDoc = callSnapshot.docs.find(doc => doc.id === callId);
    if (!callDoc || !callDoc.data().offer) {
        console.error("Call ID not found or no offer in document.");
        return;
    }
    const offer = callDoc.data().offer;

    // Set the remote description with the offer
    await newPc.setRemoteDescription(new RTCSessionDescription(offer));

    // Create and set the answer
    const answer = await newPc.createAnswer();
    await newPc.setLocalDescription(answer);

    // Save the answer to Firestore
    await setDoc(callDocRef, { answer: { ...answer.toJSON() } }, { merge: true });
    console.log("Answer sent.");

    // Listen for ICE candidates from the 'caller' and add them to the connection
    onSnapshot(collection(db.current, `artifacts/${__app_id}/public/data/calls/${callId}/candidates`), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          newPc.addIceCandidate(candidate);
        }
      });
    });
  };

  const copyCallId = () => {
    navigator.clipboard.writeText(callId);
  };
  
  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 font-sans">
      <header className="text-center mb-8">
        <h1 className="text-3xl md:text-4xl font-bold mb-2">WebRTC Camera Streamer</h1>
        <p className="text-gray-400">Stream your camera to another device using WebRTC and Firestore.</p>
      </header>

      <div className="flex flex-col lg:flex-row gap-8 max-w-6xl mx-auto">
        {/* Left column for local camera */}
        <div className="flex-1 bg-gray-800 p-6 rounded-2xl shadow-lg flex flex-col items-center">
          <h2 className="text-xl font-semibold mb-4 flex items-center">
            <Camera size={20} className="mr-2 text-green-400" />
            Your Camera Feed
          </h2>
          <div className="w-full h-[300px] bg-gray-700 rounded-xl overflow-hidden mb-4">
            <video ref={localVideoRef} autoPlay muted className="w-full h-full object-cover"></video>
          </div>
          <button
            onClick={startCamera}
            className="w-full py-3 px-6 bg-green-600 hover:bg-green-700 transition-colors rounded-xl font-bold text-lg flex items-center justify-center shadow-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 focus:ring-offset-gray-800"
          >
            <Camera size={20} className="mr-2" />
            Start My Camera
          </button>
        </div>

        {/* Right column for controls and remote stream */}
        <div className="flex-1 bg-gray-800 p-6 rounded-2xl shadow-lg flex flex-col items-center">
          <h2 className="text-xl font-semibold mb-4 flex items-center">
            <Phone size={20} className="mr-2 text-blue-400" />
            Remote Stream & Controls
          </h2>
          <div className="w-full h-[300px] bg-gray-700 rounded-xl overflow-hidden mb-4">
            <video ref={remoteVideoRef} autoPlay className="w-full h-full object-cover"></video>
          </div>
          
          <div className="w-full space-y-4">
            <div className="flex flex-col sm:flex-row gap-2">
              <button
                onClick={createCall}
                disabled={!localStream}
                className="flex-1 py-3 px-6 bg-blue-600 hover:bg-blue-700 transition-colors rounded-xl font-bold text-lg shadow-md disabled:bg-gray-600 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-800"
              >
                Create Call
              </button>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={callId}
                onChange={(e) => setCallId(e.target.value)}
                placeholder="Enter Call ID"
                className="flex-1 bg-gray-700 text-white rounded-xl py-3 px-4 focus:outline-none focus:ring-2 focus:ring-blue-500 text-center text-lg"
              />
              <button
                onClick={copyCallId}
                title="Copy Call ID"
                className="p-3 bg-gray-600 hover:bg-gray-500 transition-colors rounded-xl shadow-md focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 focus:ring-offset-gray-800"
              >
                <Copy size={20} />
              </button>
              <button
                onClick={answerCall}
                disabled={!localStream || !callId}
                className="py-3 px-6 bg-purple-600 hover:bg-purple-700 transition-colors rounded-xl font-bold text-lg shadow-md disabled:bg-gray-600 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-gray-800"
              >
                Answer Call
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;