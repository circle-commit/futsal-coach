// 수업 하나 보존 파일 약속 (js/session-file.js): 기존 백업 v2 형식 그대로, 고른 수업 1개와 그 수업이 가리키는 것만 참조가 닫히게 담는다.
// 담는 것: 그 수업(교정 원본·직전 취소·교정 기록·분석 정보·이름 연결까지 통째로), 이름이 연결된 아이(속한 반 목록 groupIds 그대로),
// 수업의 반 + 그 아이들이 속한 모든 반, 그 반들의 학교. 빼는 것: 관계없는 반·학교·아이·다른 수업. 홈의 '백업 불러오기'로 다시 연다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionBackup, sessionBackupFilename } from '../js/session-file.js';
import { analyzeFrames } from '../js/pipeline.js';
import { swapPlayerSegment } from '../js/review.js';
import { parseAnalysisFile } from '../js/analysis-file.js';

const deepFreeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const json = o => JSON.parse(JSON.stringify(o));
const ids = list => list.map(x => x.id).sort();
const korean = e => { assert.ok(e instanceof Error && !(e instanceof TypeError), `한국어 오류여야 함: ${e}`); assert.match(e.message, /[가-힣]/); return true; };

// 실제 수업 기록 모양: 파이프라인 결과를 두 번 교정(원본·직전 취소 2개·교정 기록 2개), 로컬 분석 정보, 아이 이름 연결
function realSession() {
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const kid = (t, k) => [6 + 9 * (k % 3) + 3 * Math.sin(t / (2 + k)), 4 + 4 * Math.floor(k / 3) + 3 * Math.cos(t / (3 + k))];
  const dets = [];
  for (let t = 0; t < 30; t += 1 / 7.3 + (rnd() - 0.5) * 0.02) {
    const pos = [0, 1, 2, 3, 4, 5].map(k => kid(t, k)), [bx, by] = pos[Math.floor(t / 4) % 6];
    dets.push({ t: +t.toFixed(3), players: [pos.slice(0, 3), pos.slice(3)], ball: rnd() > 0.2 ? [[bx + 0.3, by, 1]] : [] });
  }
  const R0 = json(analyzeFrames(dets, { width: 1280, height: 720, corners: [[60, 40], [1220, 50], [1240, 690], [40, 700]], court: [40, 20], teams: [{ name: '파랑', color: '#1f8fe0' }, { name: '분홍', color: '#e0367f' }] }));
  const R1 = swapPlayerSegment(R0, { playerA: 0, playerB: 1, start: 2, end: 6 }), R2 = swapPlayerSegment(R1, { playerA: 3, playerB: 4, start: 10, end: 12 });
  return {
    id: 'sess-1', groupId: 'g-main', title: '3학년 2반 풋살 / 1교시', date: '2026-11-14', createdAt: '2026-11-14T01:02:03.000Z',
    assign: { 0: 'kid-multi', 1: 'kid-plain', 4: 'kid-multi2' }, result: R2, originalResult: R0, reviewHistory: [R0, R1],
    reviewEdits: [{ type: 'swap', playerA: 0, playerB: 1, start: 2, end: 6, at: '2026-11-14T02:00:00.000Z' }, { type: 'swap', playerA: 3, playerB: 4, start: 10, end: 12, at: '2026-11-14T02:01:00.000Z' }],
    analysis: { engine: 'classical-v1', sourceName: '수업 영상.mp4', frames: 300, resumed: false },
  };
}
// 학교·반·아이: 여러 반에 속한 아이(kid-multi: 이 반 + 다른 학교 방과후반, kid-multi2: 이 반 + 같은 학교 다른 반)와 관계없는 자료
const ORG = () => ({
  schools: [{ id: 's-main', name: '한빛초', court: [35, 13.7], corners: [[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8]] }, { id: 's-other', name: '별빛초' }, { id: 's-unrelated', name: '관계없는초' }],
  groups: [{ id: 'g-main', schoolId: 's-main', name: '3학년 2반' }, { id: 'g-same-school', schoolId: 's-main', name: '3학년 1반' }, { id: 'g-other-school', schoolId: 's-other', name: '방과후 A반' },
    { id: 'g-unrelated', schoolId: 's-unrelated', name: '관계없는 반' }, { id: 'g-main-sibling', schoolId: 's-main', name: '4학년 1반' }],
  kids: [{ id: 'kid-multi', name: '김하나', groupIds: ['g-main', 'g-other-school'] }, { id: 'kid-plain', name: '이둘', groupIds: ['g-main'] },
    { id: 'kid-multi2', name: '박셋', groupIds: ['g-same-school', 'g-main'] }, { id: 'kid-not-linked', name: '최넷', groupIds: ['g-main'] }, { id: 'kid-unrelated', name: '정다섯', groupIds: ['g-unrelated'] }],
});
const input = () => ({ session: realSession(), ...ORG() });

test('수업 파일: 기존 백업 v2 모양이고, 고른 수업 1개를 교정 원본·직전 취소·교정 기록·분석 정보·이름 연결까지 그대로 담는다 (분석 결과 파일과는 다른 파일)', () => {
  const inp = deepFreeze(input()), b = buildSessionBackup(inp, '2026-11-14T09:00:00.000Z');
  assert.deepEqual(Object.keys(b).sort(), ['app', 'exportedAt', 'groups', 'kids', 'schools', 'sessions', 'version'].sort());
  assert.equal(b.app, 'futsal-coach'); assert.equal(b.version, 2); assert.equal(b.exportedAt, '2026-11-14T09:00:00.000Z');
  assert.equal(b.sessions.length, 1);
  assert.deepEqual(b.sessions[0], inp.session, '수업 전체 (result·originalResult·reviewHistory·reviewEdits·analysis·assign)');
  assert.deepEqual(json(b), b, 'JSON으로 그대로 저장됨');
  // 백업 불러오기(store.importAll)가 보는 조건, 분석 결과 가져오기는 백업 파일이라고 거부
  assert.ok(Array.isArray(b.kids) && Array.isArray(b.sessions) && Array.isArray(b.schools) && Array.isArray(b.groups));
  assert.throws(() => parseAnalysisFile(b), /백업 파일이에요/);
  // exportedAt을 안 주면 지금 시각 (ISO)
  const now = buildSessionBackup(input()).exportedAt;
  assert.equal(new Date(now).toISOString(), now);
  assert.ok(Math.abs(Date.parse(now) - Date.now()) < 60000);
});

test('참조 닫힘: 여러 반에 속한 아이의 groupIds를 줄이지 않고 그 반들과 학교까지 담으며, 관계없는 반·학교·아이는 뺀다', () => {
  const inp = input(), b = buildSessionBackup(inp, '2026-11-14T09:00:00.000Z');
  assert.deepEqual(ids(b.kids), ['kid-multi', 'kid-multi2', 'kid-plain'], '이름이 연결된 아이만');
  for (const k of b.kids) assert.deepEqual(k, inp.kids.find(x => x.id === k.id), `${k.id}: 아이 기록(속한 반 목록 포함) 그대로`);
  assert.deepEqual(ids(b.groups), ['g-main', 'g-other-school', 'g-same-school'], '수업의 반 + 아이들이 속한 모든 반');
  assert.deepEqual(ids(b.schools), ['s-main', 's-other'], '그 반들의 학교');
  for (const x of [...b.groups, ...b.schools]) assert.deepEqual(x, [...inp.groups, ...inp.schools].find(y => y.id === x.id), `${x.id} 그대로 (코트 기억 포함)`);
  // 담긴 것끼리 참조가 모두 닫혀 있음
  const has = (list, id) => list.some(x => x.id === id), s = b.sessions[0];
  assert.ok(has(b.groups, s.groupId));
  b.groups.forEach(g => assert.ok(has(b.schools, g.schoolId), `${g.id}의 학교`));
  Object.values(s.assign).forEach(k => assert.ok(has(b.kids, k), `연결된 아이 ${k}`));
  b.kids.forEach(k => k.groupIds.forEach(g => assert.ok(has(b.groups, g), `${k.id}의 반 ${g}`)));
  // 한 아이가 두 번 연결돼도 한 번만
  const twice = input(); twice.session.assign = { 0: 'kid-multi', 3: 'kid-multi' };
  const b2 = buildSessionBackup(twice, '2026-11-14T09:00:00.000Z');
  assert.deepEqual(ids(b2.kids), ['kid-multi']); assert.deepEqual(ids(b2.groups), ['g-main', 'g-other-school']); assert.deepEqual(ids(b2.schools), ['s-main', 's-other']);
});

test('아직 교정·이름 연결이 없는 원본 수업도 그대로 담고, 없는 칸을 새로 만들지 않는다', () => {
  const inp = input(), raw = { id: 'sess-raw', groupId: 'g-main', title: '원본 수업', date: '2026-11-13', createdAt: '2026-11-13T00:00:00.000Z', assign: {}, result: inp.session.originalResult };
  const b = buildSessionBackup(deepFreeze({ ...inp, session: raw }), '2026-11-14T09:00:00.000Z');
  assert.deepEqual(b.sessions, [raw]);
  for (const k of ['originalResult', 'reviewHistory', 'reviewEdits', 'analysis']) assert.equal(k in b.sessions[0], false, k);
  assert.deepEqual(b.kids, []); assert.deepEqual(ids(b.groups), ['g-main']); assert.deepEqual(ids(b.schools), ['s-main']);
});

test('깊은 복사·입력 불변: 얼린 입력도 되고, 돌려준 값을 고쳐도 입력은 그대로다', () => {
  const inp = deepFreeze(input()), before = JSON.stringify(inp), b = buildSessionBackup(inp, '2026-11-14T09:00:00.000Z');
  assert.equal(JSON.stringify(inp), before);
  // 입력이 얼어 있어서, 돌려준 값이 입력의 객체·배열을 같이 쓰면 아래 고치기가 TypeError로 실패한다
  const s = b.sessions[0];
  s.result.players[0].path[0] = 999; s.originalResult.players[0].label = 'x'; s.reviewHistory[1].ball[0] = 1; s.reviewHistory.push(null);
  s.reviewEdits[0].start = 99; s.analysis.sourceName = 'y'; s.assign[0] = 'z'; s.title = 't';
  b.kids[0].groupIds.push('g-x'); b.kids[0].name = 'n'; b.groups[0].name = 'g'; b.schools[0].corners[0][0] = 5;
  assert.equal(JSON.stringify(inp), before);
});

test('빠진 참조는 한국어 오류: 수업의 반, 반의 학교, 이름이 연결된 아이, 그 아이가 속한 다른 반이 목록에 없으면 파일을 만들지 않는다', () => {
  const cases = {
    '수업의 반': x => { x.groups = x.groups.filter(g => g.id !== 'g-main'); },
    '반의 학교': x => { x.schools = x.schools.filter(s => s.id !== 's-main'); },
    '다른 반의 학교': x => { x.schools = x.schools.filter(s => s.id !== 's-other'); },
    '연결된 아이': x => { x.kids = x.kids.filter(k => k.id !== 'kid-plain'); },
    '아이가 속한 다른 반': x => { x.groups = x.groups.filter(g => g.id !== 'g-other-school'); },
  };
  for (const [name, mut] of Object.entries(cases)) {
    const x = input(); mut(x);
    assert.throws(() => buildSessionBackup(deepFreeze(x), '2026-11-14T09:00:00.000Z'), korean, name);
  }
  assert.throws(() => buildSessionBackup({ ...input(), session: null }), korean, '수업 없음');
});

test('파일 이름: 경로·금지 문자·제어 문자 없는 .json, 이모지·긴 한글·잘못된 긴 날짜여도 파일 시스템 한도(UTF-8 255바이트) 안이고 글자 중간에서 안 잘림, 같은 수업은 같은 이름, 분석 결과·작업 설정 파일 이름과 구별', () => {
  const base = realSession();
  const check = (f, what) => {
    assert.equal(typeof f, 'string', what);
    assert.match(f, /\.json$/, `${what}: ${f}`);
    assert.ok(f.isWellFormed(), `${what}: 이모지가 반쪽으로 잘림(짝 없는 surrogate)`);
    assert.ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(f), `${what}: 금지 문자 ${JSON.stringify(f)}`);
    assert.ok(!f.startsWith('.'), `${what}: 점으로 시작 ${f}`);
    assert.ok(f.length > '.json'.length, `${what}: 빈 이름`);
    assert.ok(Buffer.byteLength(f, 'utf8') <= 255, `${what}: ${Buffer.byteLength(f, 'utf8')}바이트`);
    assert.ok(!/-(결과|작업)\.json$/.test(f), `${what}: 분석 결과·작업 설정 파일처럼 보이는 이름 ${f}`);
  };
  for (const title of ['3학년 2반 풋살 / 1교시', 'a\\b:c*d?e"f<g>h|i', '줄\n바꿈\t탭\u0000널', '../../etc/passwd', '...', '   ', 'CON']) check(sessionBackupFilename(deepFreeze({ ...base, title })), JSON.stringify(title));
  const long = [['2026-11-14', '😀'.repeat(60)], ['2026-11-14', '😀'.repeat(300)], ['2026-11-14', '가'.repeat(300)], ['2026-11-14', 'a' + '😀'.repeat(59) + '가나다'],
    ['9'.repeat(200), '가'.repeat(300)], ['😀'.repeat(100), '😀'.repeat(100)], ['날짜'.repeat(80), 'x']];
  for (const [date, title] of long) check(sessionBackupFilename(deepFreeze({ ...base, date, title })), `날짜 ${date.length}자·제목 ${title.length}자`);
  assert.ok(sessionBackupFilename({ ...base, title: '😀'.repeat(60) }).includes('😀'), '이모지 제목도 한도 안에서 남김');
  assert.equal(sessionBackupFilename(base), sessionBackupFilename(realSession()), '같은 수업 → 같은 이름');
});
