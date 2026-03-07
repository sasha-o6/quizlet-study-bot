import { useEffect, useState } from 'preact/hooks'
import WebApp from '@twa-dev/sdk'
import './index.css'
import { Settings, Home, PlusCircle, Loader2 } from 'lucide-preact'

// Using Vite env variable
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api'

type TUserData = {
  totalWords: number
  learnedWords: number
  settings: {
    interval: number
    batch: number
    quietStart: number
    quietEnd: number
    isActive: boolean
  }
}

function App() {
  const [activeTab, setActiveTab] = useState<'home' | 'settings' | 'add'>('home')
  const [userData, setUserData] = useState<TUserData | null>(null)
  const [loading, setLoading] = useState(true)

  // Assuming WebApp.initDataUnsafe.user.id is available in TMA
  // For local dev outside Telegram, we fallback to a dummy user if backend allows
  const tgUserId = WebApp.initDataUnsafe?.user?.id || 123456789

  useEffect(() => {
    WebApp.ready()
    WebApp.expand()
    
    const applyTheme = () => {
      document.documentElement.classList.toggle('dark', WebApp.colorScheme === 'dark')
    }
    
    applyTheme()
    WebApp.onEvent('themeChanged', applyTheme)
    
    return () => WebApp.offEvent('themeChanged', applyTheme)
  }, [])

  const fetchUserData = async () => {
    try {
      setLoading(true)
      const res = await fetch(`${API_URL}/user`, {
        headers: {
          'Authorization': `Bearer ${tgUserId}`
        }
      })
      if (res.ok) {
        setUserData(await res.json())
      }
    } catch (error) {
       console.error("Failed to fetch user data", error)
    } finally {
       setLoading(false)
    }
  }

  useEffect(() => {
    fetchUserData()
  }, [])

  const handleSaveSettings = async (e: Event) => {
    e.preventDefault()
    if (!userData) return
    const formData = new FormData(e.target as HTMLFormElement)
    
    try {
      WebApp.MainButton.showProgress()
      const res = await fetch(`${API_URL}/user/settings`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${tgUserId}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          interval: Number(formData.get('interval')),
          batch: Number(formData.get('batch')),
          quietStart: Number(formData.get('quietStart')),
          quietEnd: Number(formData.get('quietEnd')),
          isActive: formData.get('isActive') === 'on'
        })
      })

      if (res.ok) {
         WebApp.showAlert('Settings saved!')
         fetchUserData()
      }
    } catch (error) {
       WebApp.showAlert('Failed to save settings')
    } finally {
       WebApp.MainButton.hideProgress()
    }
  }

  return (
    <div className="min-h-screen pb-20">
      <header className="px-6 py-4 sticky top-0 bg-[var(--color-bg)] z-10 bg-opacity-90 backdrop-blur-md">
        <h1 className="text-2xl font-bold tracking-tight">
          {activeTab === 'home' && 'Your Progress'}
          {activeTab === 'settings' && 'Settings'}
          {activeTab === 'add' && 'Add Set'}
        </h1>
      </header>

      <main className="px-6 py-4 space-y-6">
        {loading && (
           <div className="flex justify-center py-10">
             <Loader2 className="animate-spin text-[var(--color-primary)]" size={32} />
           </div>
        )}

        {!loading && activeTab === 'home' && (
          <div className="card">
            <h2 className="font-semibold text-lg mb-2">Welcome</h2>
            <p className="text-[var(--color-gray)] text-sm mb-4">
              Here you will see your learning progress and daily stats.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)]">
                <div className="text-[var(--color-gray)] text-xs font-semibold uppercase tracking-wider mb-1">Total Words</div>
                <div className="text-2xl font-bold">{userData?.totalWords || 0}</div>
              </div>
              <div className="p-4 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)]">
                <div className="text-[var(--color-primary)] text-xs font-semibold uppercase tracking-wider mb-1">Learned</div>
                <div className="text-2xl font-bold text-[var(--color-primary)]">{userData?.learnedWords || 0}</div>
              </div>
            </div>
          </div>
        )}

        {!loading && activeTab === 'add' && (
          <div className="card text-center py-10">
            <h2 className="font-semibold text-lg mb-2">Add New Set</h2>
            <p className="text-[var(--color-gray)] text-sm mb-6">Paste a Quizlet URL below.</p>
            <form className="flex gap-2">
               <input 
                  type="text" 
                  name="url"
                  placeholder="https://quizlet.com/..." 
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-primary)] transition-colors"
                  required
                />
               <button type="submit" className="btn-primary flex items-center justify-center min-w-[50px]">+</button>
            </form>
          </div>
        )}

        {!loading && activeTab === 'settings' && userData && (
          <div className="card">
            <h2 className="font-semibold text-lg mb-4">Notifications</h2>
             <form onSubmit={handleSaveSettings} className="space-y-4">
               
               <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                 <span className="font-medium">Active</span>
                 <input type="checkbox" name="isActive" defaultChecked={userData.settings.isActive} className="w-5 h-5 accent-[var(--color-primary)]" />
               </div>

               <div>
                  <label className="text-[var(--color-gray)] text-sm block mb-1">Interval (minutes)</label>
                  <input type="number" name="interval" defaultValue={userData.settings.interval} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-primary)] transition-colors" />
               </div>
               
               <div>
                  <label className="text-[var(--color-gray)] text-sm block mb-1">Words per batch</label>
                  <input type="number" name="batch" defaultValue={userData.settings.batch} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-primary)] transition-colors" />
               </div>

               <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[var(--color-gray)] text-sm block mb-1">Quiet Start (Hr)</label>
                    <input type="number" name="quietStart" defaultValue={userData.settings.quietStart} min={0} max={23} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none" />
                  </div>
                  <div>
                    <label className="text-[var(--color-gray)] text-sm block mb-1">Quiet End (Hr)</label>
                    <input type="number" name="quietEnd" defaultValue={userData.settings.quietEnd} min={0} max={23} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none" />
                  </div>
               </div>

               <button type="submit" className="btn-primary w-full mt-4">Save Settings</button>
             </form>
          </div>
        )}
      </main>

      <nav className="fixed bottom-0 left-0 right-0 h-16 bg-[var(--color-card)] border-t border-[var(--color-border)] flex justify-between items-center px-6 safe-area-pb">
        <button onClick={() => setActiveTab('home')} className={`flex flex-col items-center justify-center w-16 h-full ${activeTab === 'home' ? 'text-[var(--color-primary)]' : 'text-[var(--color-gray)]'}`}>
          <Home size={24} />
          <span className="text-[10px] font-medium mt-1">Home</span>
        </button>
        <button onClick={() => setActiveTab('add')} className={`flex flex-col items-center justify-center w-16 h-full ${activeTab === 'add' ? 'text-[var(--color-primary)]' : 'text-[var(--color-gray)]'}`}>
          <PlusCircle size={24} />
          <span className="text-[10px] font-medium mt-1">Add</span>
        </button>
        <button onClick={() => setActiveTab('settings')} className={`flex flex-col items-center justify-center w-16 h-full ${activeTab === 'settings' ? 'text-[var(--color-primary)]' : 'text-[var(--color-gray)]'}`}>
          <Settings size={24} />
          <span className="text-[10px] font-medium mt-1">Settings</span>
        </button>
      </nav>
    </div>
  )
}

export default App
