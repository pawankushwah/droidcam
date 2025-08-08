import { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, onSnapshot, collection, addDoc, getDoc } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

const App = () => {
  const [callId, setCallId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [firebaseApp, setFirebaseApp] = useState(null);
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState('');
  const [isAuthReady, setIsAuthReady] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnection = useRef(null);

  // Firestore path constants. You'll need to update 'your-app-id'
  // to a unique identifier for your app.
  const appId = 'your-app-id';
  const callsCollectionPath = `/artifacts/${appId}/public/data/calls`;

  // Your Firebase project configurationa
  // You need to replace this with the config from your Firebase project.
  // Go to your Firebase Console -> Project Settings -> Your apps
  const firebaseConfig = {
    apiKey: import.meta.env.VITE_REACT_APP_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_REACT_APP_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_REACT_APP_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_REACT_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_REACT_APP_FIREBASE_APP_ID
  };

  // 1. Initialize Firebase and authenticate
  useEffect(() => {
    try {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const firebaseAuth = getAuth(app);

      setFirebaseApp(app);
      setDb(firestore);
      setAuth(firebaseAuth);

      onAuthStateChanged(firebaseAuth, async (user) => {
        if (user) {
          setUserId(user.uid);
          setIsAuthReady(true);
        } else {
          // Sign in anonymously for a simple, public app
          await signInAnonymously(firebaseAuth);
        }
      });
    } catch (e) {
      console.error("Error initializing Firebase:", e);
      setError("Failed to initialize Firebase. Check console for details.");
    }
  }, []);

  // 2. Set up WebRTC peer connection
  useEffect(() => {
    if (!isAuthReady) return;

    // Use a STUN server to help peers find each other
    const servers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
      iceCandidatePoolSize: 10,
    };
    peerConnection.current = new RTCPeerConnection(servers);

    // Get local media stream (camera and microphone)
    const getLocalStream = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        stream.getTracks().forEach((track) => {
          peerConnection.current.addTrack(track, stream);
        });
      } catch (e) {
        console.error('Error getting user media:', e);
        setError('Could not get access to camera and microphone. Please allow permissions.');
      }
    };
    
    getLocalStream();

    // Event listener for when the remote peer adds a track
    peerConnection.current.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        if (remoteVideoRef.current.srcObject) {
          remoteVideoRef.current.srcObject.addTrack(track);
        } else {
          remoteVideoRef.current.srcObject = event.streams[0];
        }
      });
    };

    return () => {
      if (peerConnection.current) {
        peerConnection.current.close();
      }
    };
  }, [isAuthReady]);

  // 3. Create a new call
  const createCall = async () => {
    if (!db || !isAuthReady) {
      setError('Firebase not ready or user not authenticated.');
      return;
    }
    setLoading(true);
    try {
      const callDocRef = await addDoc(collection(db, callsCollectionPath), {});
      const newCallId = callDocRef.id;
      setCallId(newCallId);

      // Create a reference to the ICE candidate collections
      const callerCandidatesCollection = collection(callDocRef, 'callerCandidates');
      const calleeCandidatesCollection = collection(callDocRef, 'calleeCandidates');

      // Listen for ICE candidates from the local peer and save them to Firestore
      peerConnection.current.onicecandidate = (event) => {
        if (event.candidate) {
          addDoc(callerCandidatesCollection, event.candidate.toJSON());
        }
      };

      // Create an offer and set it as the local description
      const offerDescription = await peerConnection.current.createOffer();
      await peerConnection.current.setLocalDescription(offerDescription);

      // Save the offer to Firestore
      const offer = {
        sdp: offerDescription.sdp,
        type: offerDescription.type,
      };
      await setDoc(callDocRef, { offer });

      // Listen for the remote answer
      onSnapshot(callDocRef, (snapshot) => {
        const data = snapshot.data();
        if (data?.answer && !peerConnection.current.currentRemoteDescription) {
          const answerDescription = new RTCSessionDescription(data.answer);
          peerConnection.current.setRemoteDescription(answerDescription);
        }
      });

      // Listen for ICE candidates from the remote peer and add them to the connection
      onSnapshot(calleeCandidatesCollection, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            peerConnection.current.addIceCandidate(candidate);
          }
        });
      });

      setLoading(false);
    } catch (e) {
      console.error('Error creating call:', e);
      setError('Failed to create call. See console for details.');
      setLoading(false);
    }
  };

  // 4. Join an existing call
  const joinCall = async () => {
    if (!db || !isAuthReady || !callId) {
      setError('Firebase not ready or call ID is missing.');
      return;
    }
    setLoading(true);
    try {
      const callDocRef = doc(db, callsCollectionPath, callId);
      const callDoc = await getDoc(callDocRef);
      if (!callDoc.exists()) {
        setError('Call with this ID does not exist.');
        setLoading(false);
        return;
      }
      
      const offer = callDoc.data().offer;
      await peerConnection.current.setRemoteDescription(new RTCSessionDescription(offer));

      // Create a reference to the ICE candidate collections
      const callerCandidatesCollection = collection(callDocRef, 'callerCandidates');
      const calleeCandidatesCollection = collection(callDocRef, 'calleeCandidates');

      // Listen for ICE candidates from the local peer and save them to Firestore
      peerConnection.current.onicecandidate = (event) => {
        if (event.candidate) {
          addDoc(calleeCandidatesCollection, event.candidate.toJSON());
        }
      };

      // Create an answer and set it as the local description
      const answerDescription = await peerConnection.current.createAnswer();
      await peerConnection.current.setLocalDescription(answerDescription);

      // Save the answer to Firestore
      const answer = {
        sdp: answerDescription.sdp,
        type: answerDescription.type,
      };
      await setDoc(callDocRef, { answer }, { merge: true });

      // Listen for ICE candidates from the remote peer and add them to the connection
      onSnapshot(callerCandidatesCollection, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            peerConnection.current.addIceCandidate(candidate);
          }
        });
      });

      setLoading(false);
    } catch (e) {
      console.error('Error joining call:', e);
      setError('Failed to join call. See console for details.');
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white p-4">
      <div className="w-full max-w-4xl bg-gray-800 rounded-xl shadow-lg p-6 flex flex-col md:flex-row gap-6">
        {/* Video Streams */}
        <div className="flex-1 flex flex-col items-center gap-4">
          <h2 className="text-xl font-semibold">Local Video</h2>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            className="w-full bg-black rounded-lg shadow-inner border border-gray-700"
            style={{ aspectRatio: '16/9' }}
          ></video>
          <h2 className="text-xl font-semibold mt-4">Remote Video</h2>
          <video
            ref={remoteVideoRef}
            autoPlay
            className="w-full bg-black rounded-lg shadow-inner border border-gray-700"
            style={{ aspectRatio: '16/9' }}
          ></video>
        </div>

        {/* Controls */}
        <div className="w-full md:w-80 flex flex-col gap-4">
          <h1 className="text-3xl font-bold text-center mb-4">WebRTC Video Call</h1>
          <div className="flex flex-col gap-4 p-4 bg-gray-700 rounded-lg shadow">
            {isAuthReady && userId && (
              <p className="text-sm text-center text-gray-300 break-all">
                Your User ID: <span className="font-mono text-xs">{userId}</span>
              </p>
            )}
            <button
              onClick={createCall}
              disabled={loading}
              className="w-full px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-full transition-colors duration-200 shadow-md disabled:bg-gray-500"
            >
              {loading ? 'Creating...' : 'Create Call'}
            </button>
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={callId}
                onChange={(e) => setCallId(e.target.value)}
                placeholder="Enter Call ID"
                className="w-full p-2 bg-gray-800 text-white rounded-lg border border-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={joinCall}
                disabled={loading || !callId}
                className="w-full px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-bold rounded-full transition-colors duration-200 shadow-md disabled:bg-gray-500"
              >
                {loading ? 'Joining...' : 'Join Call'}
              </button>
            </div>
            {error && (
              <div className="mt-4 p-3 text-red-300 bg-red-900 rounded-lg text-center font-medium break-words">
                {error}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;