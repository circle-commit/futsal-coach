// 수업 하나만 파일로 보존하기: 고른 수업 기록을 기존 백업 파일 형식(app 'futsal-coach', version 2) 그대로 만든다.
// 홈의 '백업 불러오기'(store.importAll)로 다시 연다. 새 파일 형식·새 복원 경로는 없다. (순수 함수, 브라우저·node 공통)
// 담는 범위 = 이 수업이 가리키는 것만 (참조 닫힘):
//   sessions: 고른 수업 1개. result·originalResult·reviewHistory·reviewEdits·analysis·assign·title·date·id 등 저장된 칸 그대로
//   kids:     그 수업의 assign이 이름을 연결한 아이만. kid.groupIds는 그대로 둔다
//             (현재 반 하나로 줄이면, 같은 브라우저에 복원할 때 그 아이의 다른 반 연결을 덮어써 잃는다)
//   groups:   이 수업의 반 + 연결한 아이들의 groupIds에 있는 반 모두 (이 수업의 반이 맨 앞)
//   schools:  그 반들의 학교 모두 (이 수업의 학교가 맨 앞). 학교에 저장된 코트 크기·모서리도 그대로
//   그 밖의 반·학교·아이·수업은 넣지 않는다. 나머지 순서는 받은 목록 순서.
// 입력은 바꾸지 않고, JSON으로 깊은 복사한 값을 돌려준다 (영상·Blob·objectURL은 저장된 수업에 없음).
// 이 수업이 없거나, 이 수업의 반·학교, 연결한 아이, 그 아이의 반·학교를 찾을 수 없으면 한국어 오류 (전체 백업을 안내).

const FULL = ' 이 수업만 따로 저장할 수 없으니, 홈의 "백업 파일 받기"로 전체 백업을 받아 주세요.';
const fail = msg => { throw new Error(msg + FULL); };
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = v => (typeof v === 'string' && v !== '') || Number.isFinite(v);

// id → 기록 (같은 id가 또 있으면 앞의 것)
function index(list) {
  const m = new Map();
  for (const x of Array.isArray(list) ? list : []) if (isObj(x) && isId(x.id) && !m.has(x.id)) m.set(x.id, x);
  return m;
}
// ids에 든 것만: first를 맨 앞에, 나머지는 받은 목록 순서로
const pick = (m, first, ids) => [first, ...[...m.keys()].filter(id => id !== first && ids.has(id))].map(id => m.get(id));

/** { session, schools, groups, kids }: store.getSession·listSchools·listGroups·listKids 결과. exportedAt: 생략하면 지금 (Date·ISO 글자·ms)
 * 반환: { app: 'futsal-coach', version: 2, exportedAt: ISO, schools, groups, kids, sessions: [그 수업] } (store.exportAll과 같은 모양) */
export function buildSessionBackup({ session, schools, groups, kids } = {}, exportedAt) {
  if (!isObj(session) || !isId(session.id)) throw new Error('저장할 수업 기록이 없어요. 수업 결과 화면에서 다시 해 주세요.');
  const at = exportedAt == null ? new Date() : new Date(exportedAt);
  if (Number.isNaN(at.getTime())) throw new Error('저장 시각(exportedAt)이 올바른 날짜가 아니에요.');
  const S = index(schools), G = index(groups), K = index(kids);

  const group = G.get(session.groupId);
  if (!group) fail('이 수업의 반을 찾을 수 없어요.');
  if (!S.has(group.schoolId)) fail('이 수업의 학교를 찾을 수 없어요.');

  const kidIds = new Set(Object.values(isObj(session.assign) ? session.assign : {}).filter(isId));
  const lost = [...kidIds].filter(id => !K.has(id)).length;
  if (lost) fail(`이름을 연결한 아이 ${lost}명을 아이 명단에서 찾을 수 없어요.`);

  const groupIds = new Set([group.id]);
  for (const id of kidIds) {
    const gs = K.get(id).groupIds;
    for (const g of Array.isArray(gs) ? gs : []) {
      if (!G.has(g)) fail('이름을 연결한 아이가 속한 반 가운데 찾을 수 없는 반이 있어요.');
      groupIds.add(g);
    }
  }
  const schoolIds = new Set();
  for (const g of groupIds) {
    const sc = G.get(g).schoolId;
    if (!S.has(sc)) fail('이름을 연결한 아이가 속한 반의 학교를 찾을 수 없어요.');
    schoolIds.add(sc);
  }

  return JSON.parse(JSON.stringify({ // 깊은 복사: 입력과 객체·배열을 나눠 쓰지 않음
    app: 'futsal-coach', version: 2, exportedAt: at.toISOString(),
    schools: pick(S, group.schoolId, schoolIds),
    groups: pick(G, group.id, groupIds),
    kids: [...K.keys()].filter(id => kidIds.has(id)).map(id => K.get(id)),
    sessions: [session],
  }));
}

// 파일 이름에 못 쓰는 글자(\ / : * ? " < > |)·제어 문자·글자 방향 제어 문자는 공백으로 → 앞뒤 공백 정리 → 공백은 _ (한글은 그대로), 최대 60글자
const clean = s => Array.from(String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]+/g, ' ').trim().replace(/\s+/g, '_')).slice(0, 60).join('');

// 파일 이름 한도는 UTF-8 255바이트라 여유를 두고 240바이트 (한글 3·이모지 4바이트라 60글자 제한만으로는 넘을 수 있음)
const enc = new TextEncoder(), MAX_BYTES = 240, EXT = '.json';
// 글자(코드 포인트) 경계에서 UTF-8 max바이트 이하로 자른다
const cutBytes = (s, max) => { let out = '', n = 0; for (const ch of s) { n += enc.encode(ch).length; if (n > max) break; out += ch; } return out; };

/** '풋살코치-분석결과-날짜-제목.json'. 날짜·제목이 비면 '날짜없음'·'수업'.
 * 확장자까지 합친 이름이 UTF-8 240바이트 이하가 되게 뒤(제목 끝)부터 글자 단위로 자르고, .json은 늘 남긴다 */
export function sessionBackupFilename(session) {
  const base = `풋살코치-분석결과-${clean(session?.date) || '날짜없음'}-${clean(session?.title) || '수업'}`;
  return cutBytes(base, MAX_BYTES - enc.encode(EXT).length) + EXT;
}
