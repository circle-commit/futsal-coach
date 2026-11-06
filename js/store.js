// 수업 기록·아이 명단 저장 (브라우저 IndexedDB). 영상은 저장하지 않고 분석 결과만 둔다.
const DB = 'futsal-coach', VER = 1;
let dbp;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('sessions', { keyPath: 'id' });
      r.result.createObjectStore('kids', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('저장이 취소됐어요'));
  });
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const listSessions = async () => (await tx('sessions', 'readonly', s => s.getAll())).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
export const getSession = id => tx('sessions', 'readonly', s => s.get(id));
export const putSession = x => tx('sessions', 'readwrite', s => s.put(x));
export const deleteSession = id => tx('sessions', 'readwrite', s => s.delete(id));
export const listKids = async () => (await tx('kids', 'readonly', s => s.getAll())).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
export const putKid = x => tx('kids', 'readwrite', s => s.put(x));
export const deleteKid = id => tx('kids', 'readwrite', s => s.delete(id));

// 백업: 브라우저 데이터가 지워져도 되살릴 수 있게 JSON 파일로
export async function exportAll() {
  return { app: 'futsal-coach', version: 1, exportedAt: new Date().toISOString(), kids: await listKids(), sessions: await listSessions() };
}
export async function importAll(data) {
  if (data?.app !== 'futsal-coach' || !Array.isArray(data.kids) || !Array.isArray(data.sessions)) throw new Error('이 앱의 백업 파일이 아니에요');
  const d = await db();
  await new Promise((res, rej) => { // 한 번에 넣기: 중간에 실패하면 아무것도 안 바뀜
    const t = d.transaction(['kids', 'sessions'], 'readwrite');
    data.kids.forEach(k => t.objectStore('kids').put(k));
    data.sessions.forEach(s => t.objectStore('sessions').put(s));
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
  return { kids: data.kids.length, sessions: data.sessions.length };
}
