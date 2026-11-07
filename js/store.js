// 수업 기록·학교·반·아이 명단 저장 (브라우저 IndexedDB). 영상은 저장하지 않고 분석 결과만 둔다.
// 학교 > 반 > 아이. 아이는 여러 반에 속할 수 있고(kid.groupIds), 수업 기록은 한 반에 묶인다(session.groupId).
const DB = 'futsal-coach', VER = 2, STORES = ['sessions', 'kids', 'schools', 'groups'];
export const UNSORTED = '__unsorted'; // 학교·반 기능 전에 만든 기록을 모아 두는 곳
let dbp;
function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).then(async d => { await migrate(d); return d; });
  return dbp;
}
function run(d, stores, mode, fn) {
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode), out = fn(t);
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('저장이 취소됐어요'));
  });
}
const tx = async (store, mode, fn) => run(await db(), store, mode, t => fn(t.objectStore(store)));
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** 반이 없는 아이·수업을 "분류 안 됨" 반으로 옮긴다. 아무것도 지우지 않는다. */
async function migrate(d) {
  const all = s => run(d, s, 'readonly', t => t.objectStore(s).getAll());
  const [kids, sessions] = await Promise.all([all('kids'), all('sessions')]);
  const lostKids = kids.filter(k => !k.groupIds?.length), lostSessions = sessions.filter(s => !s.groupId);
  if (!lostKids.length && !lostSessions.length) return;
  await run(d, STORES, 'readwrite', t => {
    t.objectStore('schools').put({ id: UNSORTED, name: '분류 안 됨' });
    t.objectStore('groups').put({ id: UNSORTED, schoolId: UNSORTED, name: '분류 안 됨' });
    lostKids.forEach(k => t.objectStore('kids').put({ ...k, groupIds: [UNSORTED] }));
    lostSessions.forEach(s => t.objectStore('sessions').put({ ...s, groupId: UNSORTED }));
  });
}

const byName = (a, b) => (a.id === UNSORTED) - (b.id === UNSORTED) || a.name.localeCompare(b.name, 'ko'); // "분류 안 됨"은 맨 뒤
export const listSessions = async () => (await tx('sessions', 'readonly', s => s.getAll())).sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
export const getSession = id => tx('sessions', 'readonly', s => s.get(id));
export const putSession = x => tx('sessions', 'readwrite', s => s.put(x));
export const deleteSession = id => tx('sessions', 'readwrite', s => s.delete(id));
export const listKids = async () => (await tx('kids', 'readonly', s => s.getAll())).sort(byName);
export const putKid = x => tx('kids', 'readwrite', s => s.put(x));
export const listSchools = async () => (await tx('schools', 'readonly', s => s.getAll())).sort(byName);
export const putSchool = x => tx('schools', 'readwrite', s => s.put(x));
export const listGroups = async () => (await tx('groups', 'readonly', s => s.getAll())).sort(byName);
export const putGroup = x => tx('groups', 'readwrite', s => s.put(x));

/** 아이를 명단에서 뺀다: 수업 기록은 남기고 이름 연결만 푼다 */
export async function deleteKid(id) {
  const sessions = await listSessions();
  await run(await db(), ['kids', 'sessions'], 'readwrite', t => {
    for (const s of sessions) {
      const a = Object.fromEntries(Object.entries(s.assign || {}).filter(([, v]) => v !== id));
      if (Object.keys(a).length !== Object.keys(s.assign || {}).length) t.objectStore('sessions').put({ ...s, assign: a });
    }
    t.objectStore('kids').delete(id);
  });
}
/** 반을 지운다. 수업 기록이 있으면 지우지 않는다(기록 보호). 아이는 그 반에서만 빠진다 */
export async function deleteGroup(id) {
  if ((await listSessions()).some(s => s.groupId === id)) throw new Error('이 반에 수업 기록이 있어서 지울 수 없어요. 기록을 먼저 지워 주세요.');
  const kids = await listKids();
  await run(await db(), ['kids', 'groups'], 'readwrite', t => {
    kids.filter(k => k.groupIds.includes(id)).forEach(k => t.objectStore('kids').put({ ...k, groupIds: k.groupIds.filter(g => g !== id) }));
    t.objectStore('groups').delete(id);
  });
}
export async function deleteSchool(id) {
  if ((await listGroups()).some(g => g.schoolId === id)) throw new Error('반이 남아 있어서 지울 수 없어요. 반을 먼저 지워 주세요.');
  await tx('schools', 'readwrite', s => s.delete(id));
}

// 백업: 브라우저 데이터가 지워져도 되살릴 수 있게 JSON 파일로
export async function exportAll() {
  const [kids, sessions, schools, groups] = await Promise.all([listKids(), listSessions(), listSchools(), listGroups()]);
  return { app: 'futsal-coach', version: 2, exportedAt: new Date().toISOString(), schools, groups, kids, sessions };
}
export async function importAll(data) {
  if (data?.app !== 'futsal-coach' || !Array.isArray(data.kids) || !Array.isArray(data.sessions)) throw new Error('이 앱의 백업 파일이 아니에요');
  const d = await db();
  await run(d, STORES, 'readwrite', t => { // 한 번에 넣기: 중간에 실패하면 아무것도 안 바뀜
    for (const s of STORES) (data[s] || []).forEach(x => t.objectStore(s).put(x));
  });
  await migrate(d); // 학교·반 전 백업(version 1)이면 "분류 안 됨"으로
  return { kids: data.kids.length, sessions: data.sessions.length, schools: (data.schools || []).length };
}
