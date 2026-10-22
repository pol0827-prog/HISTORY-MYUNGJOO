import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

// Firebase 웹 설정값 (history-myungjoo 프로젝트)
// 브라우저에 공개되는 값이라 코드에 있어도 괜찮아요. 데이터는 firestore.rules 가 지킵니다.
// Vercel 환경 변수(VITE_FIREBASE_...)를 넣으면 그 값이 우선 적용돼요.
const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyAdEMe5mVpIpglLZgQSb21mpC8dRL1ru9A',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'history-myungjoo.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'history-myungjoo',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || 'history-myungjoo.firebasestorage.app',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '941078913662',
  appId: env.VITE_FIREBASE_APP_ID || '1:941078913662:web:a6fbfa869e1c420aa0ae2f',
};

export const configured = Boolean(config.apiKey && config.projectId);
export const app = configured ? initializeApp(config) : null;
export const db = configured ? getFirestore(app) : null;
export const auth = configured ? getAuth(app) : null;
export const PROJECT_ID = config.projectId;
