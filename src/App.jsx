import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, setDoc, getDocs, collection, query, addDoc } from 'firebase/firestore';
import { Camera, Phone, Copy } from 'lucide-react';

// This app uses Tailwind CSS, which is assumed to be available
const App = () => {
  // 1. Paste your Firebase config here
  // IMPORTANT: Replace the placeholder values with your actual project's configuration.
  const firebaseConfig = {
    apiKey: import.meta.env.VITE_REACT_APP_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_REACT_APP_FIREBASE_APP_ID
  };
  const appId = firebaseConfig.appId;

  // State variables for managing the app's data
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callId, setCallId] = useState('');
  const [, setUserId] = useState(null);
  const [, setIsAuthReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // useRef to hold references to DOM elements and the RTCPeerConnection object
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const pc = useRef(null);

  // Firebase service references
  const db = useRef(null);
  const auth = useRef(null);

  // This useEffect hook runs once to initialize Firebase and handle authentication
  useEffect(() => {
    const setupFirebase = async () => {
      try {
        // CORRECTION: Removed the appId as a second argument. It's already in the config object.
        const firebaseApp = initializeApp(firebaseConfig);
        db.current = getFirestore(firebaseApp);
        auth.current = getAuth(firebaseApp);

        // For local development, use anonymous sign-in directly.
        await signInAnonymously(auth.current);

        // Set up an auth state change listener to get the user ID
        const unsubscribe = onAuthStateChanged(auth.current, (user) => {
          if (user) {
            setUserId(user.uid);
          } else {
            // Fallback to a random ID if no user is authenticated
            setUserId(crypto.randomUUID());
          }
          setIsAuthReady(true);
        });

        // Cleanup function for the listener
        return () => unsubscribe();
      } catch (error) {
        console.error("Error setting up Firebase:", error);
        setErrorMessage("Failed to set up Firebase. Check the console for details.");
      }
    };
    setupFirebase();
  }, [appId]);

  // Sync the remote stream with the video element
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  // Sync the local stream with the video element
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // Function to get camera and microphone access
  const startCamera = async () => {
    setErrorMessage('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
    } catch (err) {
      console.error("Error accessing media devices:", err);
      setErrorMessage("Could not access camera/mic. Please check permissions.");
    }
  };

  // Centralized function to create and configure the RTCPeerConnection
  const createPeerConnection = () => {
    const iceServers = {
      iceServers: [
        {
          urls: 'stun:stun.l.google.com:19302'
        },
      ],
    };

    // Create the new peer connection instance
    const newPc = new RTCPeerConnection(iceServers);
    pc.current = newPc;

    // Listen for ICE candidates and save them to Firestore
    newPc.onicecandidate = async (event) => {
      if (event.candidate) {
        console.log("Found ICE candidate:", event.candidate);
        // Use the new appId variable here
        const candidatesCollectionRef = collection(db.current, `artifacts/${appId}/public/data/calls/${callId}/candidates`);
        // Add the candidate to Firestore, adding a type to distinguish caller/callee candidates
        await addDoc(candidatesCollectionRef, { ...event.candidate.toJSON(), type: localStream === newPc.getLocalStreams()[0] ? 'caller' : 'callee' });
      }
    };

    // Listen for the remote track and add it to the remote video element
    newPc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        console.log("Received remote stream.");
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
      setErrorMessage("Please start your camera before creating a call.");
      return;
    }

    // Generate a unique call ID
    const newCallId = Math.floor(Math.random() * 1000000).toString();
    setCallId(newCallId);
    setErrorMessage(`Call created! Share this ID: ${newCallId}`);

    // Use the new appId variable here
    const callsCollectionRef = collection(db.current, `artifacts/${appId}/public/data/calls`);
    const newCallDocRef = doc(callsCollectionRef, newCallId);

    const newPc = createPeerConnection();

    // Create the offer and set it as the local description
    const offer = await newPc.createOffer();
    await newPc.setLocalDescription(offer);

    // Save the offer to Firestore
    await setDoc(newCallDocRef, { offer: { ...offer.toJSON() } });
    console.log(`Call created with ID: ${newCallId}`);

    // Listen for the answer from the callee
    onSnapshot(newCallDocRef, async (snapshot) => {
      const data = snapshot.data();
      // Only set the remote description if an answer exists and it hasn't been set yet
      if (data?.answer && newPc.localDescription && !newPc.currentRemoteDescription) {
        console.log("Received answer:", data.answer);
        const answerDescription = new RTCSessionDescription(data.answer);
        await newPc.setRemoteDescription(answerDescription);
      }
    });

    // Listen for ICE candidates from the callee and add them
    // Use the new appId variable here
    const candidatesCollectionRef = collection(db.current, `artifacts/${appId}/public/data/calls/${newCallId}/candidates`);
    onSnapshot(query(candidatesCollectionRef), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && change.doc.data().type === 'callee') {
          const candidate = new RTCIceCandidate(change.doc.data());
          newPc.addIceCandidate(candidate);
        }
      });
    });
  };

  // Function for the 'callee' to answer a call
  const answerCall = async () => {
    if (!db.current || !localStream || !callId) {
      setErrorMessage("Please start your camera and enter a Call ID to answer.");
      return;
    }

    const newPc = createPeerConnection();

    // Get the offer from Firestore for the specific call ID
    // Use the new appId variable here
    const callDocRef = doc(db.current, `artifacts/${appId}/public/data/calls/${callId}`);
    const callSnapshot = await getDocs(query(collection(db.current, `artifacts/${appId}/public/data/calls`)));
    const callDoc = callSnapshot.docs.find(doc => doc.id === callId);

    if (!callDoc || !callDoc.data()?.offer) {
      setErrorMessage("Call ID not found or call has no offer.");
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
    setErrorMessage("Answer sent. You should see a stream shortly.");
    console.log("Answer sent.");

    // Listen for ICE candidates from the caller and add them
    // Use the new appId variable here
    const candidatesCollectionRef = collection(db.current, `artifacts/${appId}/public/data/calls/${callId}/candidates`);
    onSnapshot(query(candidatesCollectionRef), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && change.doc.data().type === 'caller') {
          const candidate = new RTCIceCandidate(change.doc.data());
          newPc.addIceCandidate(candidate);
        }
      });
    });
  };

  // Function to copy the call ID to the clipboard
  const copyCallId = () => {
    if (callId) {
      navigator.clipboard.writeText(callId);
      setErrorMessage('Call ID copied to clipboard!');
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 font-sans">
      <header className="text-center mb-8">
        <h1 className="text-3xl md:text-4xl font-bold mb-2">WebRTC Camera Streamer</h1>
        <p className="text-gray-400">Stream your camera to another device using WebRTC and Firestore.</p>
      </header>

      {errorMessage && (
        <div className="bg-red-500 text-white p-4 rounded-xl text-center mb-4 max-w-lg mx-auto">
          {errorMessage}
        </div>
      )}

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