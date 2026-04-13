import { useEffect, useState } from 'preact/hooks';
import WebApp from '@twa-dev/sdk';
import './index.css';
import { Settings, Home, PlusCircle, Loader2, BookOpen } from 'lucide-preact';

// API_URL is now handled via same-domain reverse proxy. Use relative `/api/` urls.
interface IUserData {
  totalSets: number;
  totalWords: number;
  learnedWords: number;
  settings: {
    interval: number;
    batch: number;
    quietStart: number;
    quietStartMin: number;
    quietEnd: number;
    quietEndMin: number;
    isActive: boolean;
    timezone: string;
    quietDays: number[];
  };
}

function getAuthHeaders(): Record<string, string> {
  return {
    'X-Telegram-Init-Data': WebApp.initData || '',
    'Content-Type': 'application/json',
  };
}

function App() {
  const [activeTab, setActiveTab] = useState<'home' | 'settings' | 'add'>('home');
  const [userData, setUserData] = useState<IUserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scrapeLoading, setScrapeLoading] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<string | null>(null);
  const [quietDays, setQuietDays] = useState<number[]>([]);

  useEffect(() => {
    WebApp.ready();
    WebApp.expand();

    const applyTheme = () => {
      document.documentElement.classList.toggle('dark', WebApp.colorScheme === 'dark');
    };

    applyTheme();
    WebApp.onEvent('themeChanged', applyTheme);

    return () => WebApp.offEvent('themeChanged', applyTheme);
  }, []);

  const fetchUserData = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/user`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setUserData(data);
        setQuietDays(data.settings?.quietDays || []);

        // Auto-sync browser timezone to backend
        const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (browserTz && data.settings?.timezone !== browserTz) {
          fetch(`/api/user/settings`, {
            method: 'PATCH',
            headers: getAuthHeaders(),
            body: JSON.stringify({ timezone: browserTz }),
          }).catch(() => {}); // fire-and-forget
        }
      }
    } catch (error) {
      console.error('Failed to fetch user data', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUserData();
  }, []);

  const handleSaveSettings = async (e: Event) => {
    e.preventDefault();
    if (!userData) return;
    const formData = new FormData(e.target as HTMLFormElement);

    try {
      WebApp.MainButton.showProgress();
      const res = await fetch(`/api/user/settings`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          interval: Number(formData.get('interval')),
          batch: Number(formData.get('batch')),
          quietStart: Number(String(formData.get('quietStart')).split(':')[0]),
          quietStartMin: Number(String(formData.get('quietStart')).split(':')[1] || '0'),
          quietEnd: Number(String(formData.get('quietEnd')).split(':')[0]),
          quietEndMin: Number(String(formData.get('quietEnd')).split(':')[1] || '0'),
          isActive: formData.get('isActive') === 'on',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          quietDays: quietDays,
        }),
      });

      if (res.ok) {
        WebApp.showAlert('Settings saved!');
        fetchUserData();
      }
    } catch {
      WebApp.showAlert('Failed to save settings');
    } finally {
      WebApp.MainButton.hideProgress();
    }
  };

  const handleScrape = async (e: Event) => {
    e.preventDefault();
    if (!scrapeUrl.trim()) return;

    setScrapeLoading(true);
    setScrapeResult(null);

    try {
      const res = await fetch(`/api/scrape`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ url: scrapeUrl.trim() }),
      });

      const contentType = res.headers.get('content-type');
      if (contentType && (contentType.includes('text/plain') || contentType.includes('event-stream'))) {
        const reader = res.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (chunk) {
              const parts = chunk.split('\n\n');
              for (const part of parts) {
                if (!part.trim()) continue;
                if (part.startsWith('[RESULT] ')) {
                  const data = JSON.parse(part.substring(9));
                  if (data.success) {
                    setScrapeResult(`✅ Folder Synced! Added ${data.setsCount} sets (${data.totalWords} words).`);
                    setScrapeUrl('');
                    fetchUserData();
                  } else {
                    setScrapeResult(`❌ ${data.error || 'Unknown error'}`);
                  }
                } else if (part.startsWith('[ERROR] ')) {
                  setScrapeResult(`❌ ${part.substring(8)}`);
                } else {
                  setScrapeResult(part);
                }
              }
            }
          }
        }
      } else {
        const data = await res.json();
        if (data.success) {
          const msg = data.message
            ? `${data.title} — ${data.message}`
            : `✅ Added ${data.count} words from "${data.title}"`;
          setScrapeResult(msg);
          setScrapeUrl('');
          fetchUserData();
        } else {
          setScrapeResult(`❌ ${data.error || 'Unknown error'}`);
        }
      }
    } catch {
      setScrapeResult('❌ Network error');
    } finally {
      setScrapeLoading(false);
    }
  };

  const progressPercent = userData
    ? userData.totalWords > 0
      ? Math.round((userData.learnedWords / userData.totalWords) * 100)
      : 0
    : 0;

  return (
    <div className="min-h-screen pb-20">
      <header className="px-6 py-4 sticky top-0 bg-[var(--color-bg)] z-10 bg-opacity-90 backdrop-blur-md flex justify-between items-center">
        <h1 className="text-2xl font-bold tracking-tight">
          {activeTab === 'home' && 'Your Progress'}
          {activeTab === 'settings' && 'Settings'}
          {activeTab === 'add' && 'Add Set or Folder'}
        </h1>

        <a href="https://send.monobank.ua/jar/Ab1gRZPzfc" class={'btn-primary'}>
          Support
        </a>
      </header>

      <main className="px-6 py-4 space-y-6">
        {loading && (
          <div className="flex justify-center py-10">
            <Loader2 className="animate-spin text-[var(--color-primary)]" size={32} />
          </div>
        )}

        {/* ── HOME TAB ── */}
        {!loading && activeTab === 'home' && userData && (
          <>
            {/* Progress ring */}
            <div className="card flex flex-col items-center py-8">
              <div className="relative w-28 h-28 mb-4">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                  <circle cx="60" cy="60" r="52" stroke="var(--color-border)" strokeWidth="12" fill="none" />
                  <circle
                    cx="60"
                    cy="60"
                    r="52"
                    stroke="var(--color-primary)"
                    strokeWidth="12"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${2 * Math.PI * 52}`}
                    strokeDashoffset={`${2 * Math.PI * 52 * (1 - progressPercent / 100)}`}
                    className="transition-all duration-700"
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-2xl font-bold">
                  {progressPercent}%
                </span>
              </div>
              <p className="text-[var(--color-gray)] text-sm">Words Learned</p>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-3 gap-3">
              <div className="card text-center py-4 px-2">
                <div className="text-2xl font-bold">{userData.totalSets}</div>
                <div className="text-[var(--color-gray)] text-xs mt-1">Sets</div>
              </div>
              <div className="card text-center py-4 px-2">
                <div className="text-2xl font-bold">{userData.totalWords}</div>
                <div className="text-[var(--color-gray)] text-xs mt-1">Words</div>
              </div>
              <div className="card text-center py-4 px-2">
                <div className="text-2xl font-bold text-[var(--color-primary)]">{userData.learnedWords}</div>
                <div className="text-[var(--color-gray)] text-xs mt-1">Learned</div>
              </div>
            </div>

            {/* Quick status */}
            <div className="card flex items-center justify-between">
              <div>
                <span className="text-sm font-medium">Notifications</span>
                <p className="text-[var(--color-gray)] text-xs mt-0.5">
                  Every {userData.settings.interval} min · {userData.settings.batch} words
                </p>
              </div>
              <span
                className={`text-xs font-semibold px-3 py-1 rounded-full ${userData.settings.isActive ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'}`}>
                {userData.settings.isActive ? 'Active' : 'Paused'}
              </span>
            </div>
          </>
        )}

        {/* ── ADD SET TAB ── */}
        {!loading && activeTab === 'add' && (
          <div className="card py-8">
            <div className="flex flex-col items-center mb-6">
              <div className="w-14 h-14 rounded-2xl bg-[var(--color-primary)] bg-opacity-10 flex items-center justify-center mb-3">
                <BookOpen size={28} className="text-[var(--color-primary)]" />
              </div>
              <h2 className="font-semibold text-lg">Add New Set / Folder</h2>
              <p className="text-[var(--color-gray)] text-sm mt-1">Paste a Quizlet URL below</p>
            </div>

            <form onSubmit={handleScrape} className="flex gap-2">
              <input
                type="text"
                value={scrapeUrl}
                onInput={(e) => setScrapeUrl((e.target as HTMLInputElement).value)}
                placeholder="https://quizlet.com/..."
                className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-primary)] transition-colors"
                required
                disabled={scrapeLoading}
              />
              <button
                type="submit"
                className="btn-primary flex items-center justify-center min-w-[50px]"
                disabled={scrapeLoading}>
                {scrapeLoading ? <Loader2 size={20} className="animate-spin" /> : '+'}
              </button>
            </form>

            {scrapeResult && (
              <div
                className={`mt-4 p-3 rounded-xl text-sm ${scrapeResult.startsWith('❌') ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300'}`}>
                {scrapeResult}
              </div>
            )}
          </div>
        )}

        {/* ── SETTINGS TAB ── */}
        {!loading && activeTab === 'settings' && userData && (
          <div className="card">
            <h2 className="font-semibold text-lg mb-4">Notifications</h2>
            <form onSubmit={handleSaveSettings} className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]">
                <span className="font-medium">Active</span>
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={userData.settings.isActive}
                  className="w-5 h-5 accent-[var(--color-primary)]"
                />
              </div>

              <div>
                <label className="text-[var(--color-gray)] text-sm block mb-1">Interval (minutes)</label>
                <input
                  type="number"
                  inputmode="numeric"
                  name="interval"
                  defaultValue={userData.settings.interval}
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-primary)] transition-colors"
                />
              </div>

              <div>
                <label className="text-[var(--color-gray)] text-sm block mb-1">Words per batch</label>
                <input
                  type="number"
                  inputmode="numeric"
                  name="batch"
                  defaultValue={userData.settings.batch}
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-primary)] transition-colors"
                />
              </div>

              <hr className="border-[var(--color-border)] my-6" />

              <div>
                <label className="text-[var(--color-gray)] text-sm block mb-1">Quiet Start</label>
                <input
                  type="time"
                  name="quietStart"
                  defaultValue={`${String(userData.settings.quietStart).padStart(2, '0')}:${String(userData.settings.quietStartMin).padStart(2, '0')}`}
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-primary)] transition-colors"
                />
              </div>

              <div>
                <label className="text-[var(--color-gray)] text-sm block mb-1">Quiet End</label>
                <input
                  type="time"
                  name="quietEnd"
                  defaultValue={`${String(userData.settings.quietEnd).padStart(2, '0')}:${String(userData.settings.quietEndMin).padStart(2, '0')}`}
                  className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] outline-none focus:border-[var(--color-primary)] transition-colors"
                />
              </div>

              <div>
                <label className="text-[var(--color-gray)] text-sm block mb-2">Quiet Days</label>
                <div className="flex gap-1.5 flex-wrap">
                  {[
                    { l: 'Mon', v: 1 },
                    { l: 'Tue', v: 2 },
                    { l: 'Wed', v: 3 },
                    { l: 'Thu', v: 4 },
                    { l: 'Fri', v: 5 },
                    { l: 'Sat', v: 6 },
                    { l: 'Sun', v: 0 },
                  ].map((day) => (
                    <button
                      key={day.l}
                      type="button"
                      onClick={() =>
                        setQuietDays((prev) =>
                          prev.includes(day.v) ? prev.filter((d) => d !== day.v) : [...prev, day.v],
                        )
                      }
                      className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-colors ${
                        quietDays.includes(day.v)
                          ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                          : 'bg-[var(--color-bg)] text-[var(--color-gray)] border-[var(--color-border)]'
                      }`}>
                      {day.l}
                    </button>
                  ))}
                </div>
                <p className="text-[var(--color-gray)] text-xs mt-1.5">Tap days when you don't want notifications</p>
              </div>

              <hr className="border-[var(--color-border)] my-6" />

              <button type="submit" className="btn-primary w-full mt-4 position-sticky bottom-0">
                Save Settings
              </button>
            </form>
          </div>
        )}
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 right-0 h-16 bg-[var(--color-card)] border-t border-[var(--color-border)] flex justify-between items-center px-6 pt-2 pb-4">
        <button
          onClick={() => setActiveTab('home')}
          className={`flex flex-col items-center justify-center w-16 h-full ${activeTab === 'home' ? 'text-[var(--color-primary)]' : 'text-[var(--color-gray)]'}`}>
          <Home size={24} />
          <span className="text-[10px] font-medium mt-1">Home</span>
        </button>
        <button
          onClick={() => setActiveTab('add')}
          className={`flex flex-col items-center justify-center w-16 h-full ${activeTab === 'add' ? 'text-[var(--color-primary)]' : 'text-[var(--color-gray)]'}`}>
          <PlusCircle size={24} />
          <span className="text-[10px] font-medium mt-1">Add</span>
        </button>
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex flex-col items-center justify-center w-16 h-full ${activeTab === 'settings' ? 'text-[var(--color-primary)]' : 'text-[var(--color-gray)]'}`}>
          <Settings size={24} />
          <span className="text-[10px] font-medium mt-1">Settings</span>
        </button>
      </nav>
    </div>
  );
}

export default App;
