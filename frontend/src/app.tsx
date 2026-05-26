import { useEffect, useState } from 'preact/hooks';
import WebApp from '@twa-dev/sdk';
import './index.css';
import { Settings, Home, PlusCircle, Loader2, List, CheckCircle2, Circle, ChevronDown } from 'lucide-preact';

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

interface IWord {
  id: number;
  term: string;
  definition: string;
  isLearned: boolean;
}

interface ISet {
  id: number;
  title: string;
  createdAt: string;
  words: IWord[];
}

function getAuthHeaders(): Record<string, string> {
  return {
    'X-Telegram-Init-Data': WebApp.initData || '',
    'Content-Type': 'application/json',
  };
}

function App() {
  const [activeTab, setActiveTab] = useState<'home' | 'settings' | 'add' | 'words'>('home');
  const [userData, setUserData] = useState<IUserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scrapeLoading, setScrapeLoading] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<string | null>(null);
  const [quietDays, setQuietDays] = useState<number[]>([]);

  const [setsData, setSetsData] = useState<ISet[]>([]);
  const [wordsLoading, setWordsLoading] = useState(false);
  const [wordsFilter, setWordsFilter] = useState<'all' | 'learned' | 'unlearned'>('all');
  const [wordsSort, setWordsSort] = useState<'newest' | 'oldest'>('newest');

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

  const fetchUserData = async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
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

  const fetchSetsWords = async () => {
    try {
      setWordsLoading(true);
      const res = await fetch(`/api/sets/words`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSetsData(data.sets || []);
      }
    } catch (error) {
      console.error('Failed to fetch words data', error);
    } finally {
      setWordsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'words' && setsData.length === 0) {
      fetchSetsWords();
    }
  }, [activeTab]);

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

  const toggleLearned = async (wordId: number) => {
    // Optimistic UI update
    setSetsData((prevSets) =>
      prevSets.map((set) => ({
        ...set,
        words: set.words.map((w) => (w.id === wordId ? { ...w, isLearned: !w.isLearned } : w)),
      })),
    );
    try {
      const res = await fetch(`/api/words/${wordId}/toggle-learned`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        // Revert on error
        fetchSetsWords();
      } else {
        fetchUserData(false); // To update the learned counter on home tab without loading spinner
      }
    } catch (error) {
      fetchSetsWords();
    }
  };

  const progressPercent = userData
    ? userData.totalWords > 0
      ? Math.round((userData.learnedWords / userData.totalWords) * 100)
      : 0
    : 0;

  return (
    <div className="min-h-screen pb-20">
      <header className="px-6 py-4 sticky top-0 bg-[var(--color-bg)] z-30 bg-opacity-90 backdrop-blur-md flex justify-between items-center">
        <h1 className="text-2xl font-bold tracking-tight">
          {activeTab === 'home' && 'Your Progress'}
          {activeTab === 'settings' && 'Settings'}
          {activeTab === 'add' && 'Add Set or Folder'}
          {activeTab === 'words' && 'All Words'}
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
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="lucide lucide-book-open-icon lucide-book-open text-[var(--color-text)]">
                  <path d="M12 7v14" />
                  <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
                </svg>
              </div>
              <h2 className="font-semibold text-lg">Add New Set or Folder</h2>
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

        {/* ── WORDS TAB ── */}
        {!loading && activeTab === 'words' && (
          <div className="flex flex-col gap-4">
            {/* Filter & Sort Controls */}
            <div className="card p-4 flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Filter</span>
                <select
                  value={wordsFilter}
                  onChange={(e) => setWordsFilter((e.target as HTMLSelectElement).value as any)}
                  className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-2 py-1 text-sm outline-none cursor-pointer">
                  <option value="all">All Words</option>
                  <option value="unlearned">Unlearned</option>
                  <option value="learned">Learned</option>
                </select>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Sort Sets</span>
                <select
                  value={wordsSort}
                  onChange={(e) => setWordsSort((e.target as HTMLSelectElement).value as any)}
                  className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg px-2 py-1 text-sm outline-none cursor-pointer">
                  <option value="newest">Newest First</option>
                  <option value="oldest">Oldest First</option>
                </select>
              </div>
            </div>

            {/* Sets List */}
            {wordsLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="animate-spin text-[var(--color-primary)]" size={32} />
              </div>
            ) : (
              <div className="space-y-3">
                {setsData
                  .slice()
                  .sort((a, b) => {
                    const tA = new Date(a.createdAt).getTime();
                    const tB = new Date(b.createdAt).getTime();
                    return wordsSort === 'newest' ? tB - tA : tA - tB;
                  })
                  .map((set) => {
                    const filteredWords = set.words.filter((w) => {
                      if (wordsFilter === 'learned') return w.isLearned;
                      if (wordsFilter === 'unlearned') return !w.isLearned;
                      return true;
                    });

                    if (filteredWords.length === 0) return null;

                    return (
                      <details key={set.id} open className="card p-0 group">
                        <summary className="sticky top-[77px] bg-[var(--color-card)] z-10 p-3 font-semibold text-sm cursor-pointer border-b border-transparent group-open:border-[var(--color-border)] outline-none list-none [&::-webkit-details-marker]:hidden rounded-2xl group-open:rounded-b-none">
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-2 truncate pr-4">
                              <ChevronDown size={18} className="text-[var(--color-gray)] transition-transform duration-200 group-open:rotate-180 flex-shrink-0" />
                              <span className="truncate">{set.title}</span>
                            </div>
                            <span className="text-[var(--color-gray)] text-xs whitespace-nowrap">
                              {filteredWords.length} words
                            </span>
                          </div>
                        </summary>
                        <div className="p-3 space-y-2">
                          {filteredWords.map((word) => (
                            <div
                              key={word.id}
                              onClick={() => toggleLearned(word.id)}
                              className={`flex items-start gap-3 p-2 rounded-xl transition-colors cursor-pointer ${
                                word.isLearned
                                  ? 'bg-transparent text-[#72798e]'
                                  : 'bg-[var(--color-bg)] text-[var(--color-text)]'
                              }`}>
                              <button className="mt-0.5 flex-shrink-0">
                                {word.isLearned ? (
                                  <CheckCircle2 size={20} className="text-[var(--color-primary)]" />
                                ) : (
                                  <Circle size={20} className="text-[var(--color-gray)] opacity-50" />
                                )}
                              </button>
                              <div className="flex flex-col">
                                <span className="font-medium text-sm">{word.term}</span>
                                <span className="text-xs opacity-80 mt-0.5">{word.definition}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    );
                  })}

                {setsData.length === 0 && !wordsLoading && (
                  <div className="text-center py-10 text-[var(--color-gray)]">No words found. Add some sets!</div>
                )}
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
      <nav className="fixed bottom-0 left-0 right-0 h-16 bg-[var(--color-card)] border-t border-[var(--color-border)] flex justify-between items-center px-6 pt-2 pb-4 z-40">
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
          onClick={() => setActiveTab('words')}
          className={`flex flex-col items-center justify-center w-16 h-full ${activeTab === 'words' ? 'text-[var(--color-primary)]' : 'text-[var(--color-gray)]'}`}>
          <List size={24} />
          <span className="text-[10px] font-medium mt-1">Words</span>
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
