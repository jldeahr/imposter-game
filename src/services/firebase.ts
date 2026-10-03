import { getApp, getApps, initializeApp } from 'firebase/app'
import { browserLocalPersistence, getAuth, onAuthStateChanged, setPersistence, signInAnonymously, type Auth, type User } from 'firebase/auth'
import { getDatabase, type Database } from 'firebase/database'

const firebaseConfig = {
  apiKey: 'AIzaSyAvMVl5SHNCuTnr1suivyjKc7nHcmeWjYk',
  authDomain: 'imposter-game-6c060.firebaseapp.com',
  databaseURL: 'https://imposter-game-6c060-default-rtdb.firebaseio.com/',
  projectId: 'imposter-game-6c060',
  storageBucket: 'imposter-game-6c060.firebasestorage.app',
  messagingSenderId: '532268916380',
  appId: '1:532268916380:web:2f20d17fa9db28580f5759',
} as const

const app = getApps().length ? getApp() : initializeApp(firebaseConfig)
export const firebaseAuth: Auth = getAuth(app)
export const firebaseDatabase: Database = getDatabase(app)

let authentication: Promise<User> | null = null

export function ensureAnonymousUser(): Promise<User> {
  if (authentication) return authentication
  authentication = new Promise<User>((resolve, reject) => {
    let settled = false
    const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
      if (settled) return
      try {
        if (user) {
          settled = true
          unsubscribe()
          resolve(user)
          return
        }
        await setPersistence(firebaseAuth, browserLocalPersistence)
        const credential = await signInAnonymously(firebaseAuth)
        settled = true
        unsubscribe()
        resolve(credential.user)
      } catch (error) {
        settled = true
        unsubscribe()
        authentication = null
        reject(error)
      }
    }, (error) => {
      authentication = null
      reject(error)
    })
  })
  return authentication
}
