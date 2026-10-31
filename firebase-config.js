// ==========================================
// firebase-config.js - إعداد Firebase الأساسي (نظام ASGate CRM)
// مشروع: ahmd4mobily2026 - يدعم التشغيل السحابي والتشغيل المحلي الآمن
// ==========================================
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getFirestore,
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  updateDoc,
  getDoc,
  getDocs,
  writeBatch,
  query,
  where
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCSV4hHRE_EWQ7Q4vThpI-7AqDNQh3idg",
  authDomain: "ahmd4mobily2026.firebaseapp.com",
  projectId: "ahmd4mobily2026",
  storageBucket: "ahmd4mobily2026.firebasestorage.app",
  messagingSenderId: "365833229927",
  appId: "1:365833229927:web:49661d5dbbe53295fae6c2",
  measurementId: "G-X3NGD09PLV"
};

let app = null;
let db = null;

try {
  app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
  db = getFirestore(app);
} catch (error) {
  console.warn("إشعار Firebase: العمل في وضع التخزين المحلي الآمن (Local Storage Fallback):", error);
}

export {
  db,
  app,
  firebaseConfig,
  collection,
  onSnapshot,
  doc,
  setDoc,
  deleteDoc,
  updateDoc,
  getDoc,
  getDocs,
  writeBatch,
  query,
  where
};
export default app;
