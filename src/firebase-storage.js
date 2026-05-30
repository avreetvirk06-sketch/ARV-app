import { initializeApp } from 'firebase/app';
import { getDatabase, ref, get, set, remove } from 'firebase/database';

const firebaseConfig = {
 apiKey: "AIzaSyBZ2ENfUGOP9o-rW7ISRoJe1mdY8EOJm8E",
  authDomain: "arv-program.firebaseapp.com",
  databaseURL: "https://arv-program-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "arv-program",
  storageBucket: "arv-program.firebasestorage.app",
  messagingSenderId: "218013613133",
  appId: "1:218013613133:web:8d5815139265ae517e7004",
  measurementId: "G-HG1VQ1K07E"
};

let db;

try {
  console.log("Initialising Firebase...");
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  console.log("Firebase connected successfully");
} catch (e) {
  console.error("Firebase failed to initialise:", e.message);
}

function dbRef(key, shared) {
  const scope   = shared ? 'shared' : 'personal';
  const safeKey = key.replace(/[.#$[\]]/g, '-');
  return ref(db, `${scope}/${safeKey}`);
}

window.storage = {
  async get(key, shared = false) {
    const snapshot = await get(dbRef(key, shared));
    if (!snapshot.exists()) throw new Error('Not found: ' + key);
    return { key, value: snapshot.val(), shared };
  },

  async set(key, value, shared = false) {
    try {
      await set(dbRef(key, shared), value);
      return { key, value, shared };
    } catch (e) {
      console.error("Storage set failed:", e.message);
      return null;
    }
  },

  async delete(key, shared = false) {
    try {
      await remove(dbRef(key, shared));
      return { key, deleted: true, shared };
    } catch (e) {
      console.error("Storage delete failed:", e.message);
      return null;
    }
  },

  async list(prefix = '', shared = false) {
    try {
      const scope    = shared ? 'shared' : 'personal';
      const snapshot = await get(ref(db, scope));
      if (!snapshot.exists()) return { keys: [], prefix, shared };
      const safePrefix = prefix.replace(/[.#$[\]]/g, '-');
      const keys       = Object.keys(snapshot.val()).filter(k => k.startsWith(safePrefix));
      return { keys, prefix, shared };
    } catch (e) {
      console.error("Storage list failed:", e.message);
      return { keys: [], prefix, shared };
    }
  }
};

console.log("window.storage is ready:", typeof window.storage);