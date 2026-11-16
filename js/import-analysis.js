// 홈: 이 컴퓨터에서 따로 분석한 결과 파일(RESULT JSON) 가져오기. 백업 불러오기와 별개로, 언제나 새 수업 기록을 하나 만든다
// (이미 있는 기록은 건드리지 않음). 파일은 이 브라우저 안에서만 읽는다.
// 순서: 파일 고르기 → JSON 읽기 → analysis-file.js parseAnalysisFile 엄격 검사 → 미리보기 → 반 고르기 → 저장 → 그 수업 화면으로
import { $, esc } from './app.js';
import * as store from './store.js';
import { fmtTime } from './court.js';

// 분석 방식 코드 → 화면에 보일 말 (내부 코드는 그대로 보이지 않게)
const ENGINES = {
  'classical-v1': '색상·움직임 기반 분석 v1 (예전 방식)',
  'classical-v2': '색상·움직임 기반 분석 v2 (움직임을 예측해 따라가는 추적, 지금 기본)',
};
const engineText = e => ENGINES[e] || (e ? `알 수 없는 방식 (${e})` : '–');

/** org: orgIndex() 결과, isLeft(): 홈 화면을 떠났으면 true */
export function setupImport({ org, isLeft }) {
  const inp = $('#fResult'), box = $('#impPreview'), msgEl = $('#impMsg'), selG = $('#impGroup'), save = $('#impSave'), note = $('#impGroupNote');
  const groups = org.groups.filter(g => g.id !== store.UNSORTED && org.school[g.schoolId]); // "분류 안 됨"에는 넣지 않음 (새 분석과 같게)
  let picked = null, seq = 0, saving = false;
  const say = (text, err = false, focus = false) => { msgEl.textContent = text; msgEl.classList.toggle('err', err); if (focus) msgEl.focus({ preventScroll: true }); };
  const syncSave = () => { save.disabled = saving || !picked || !selG.value; selG.disabled = saving || !groups.length; };
  const clear = () => { picked = null; box.hidden = true; syncSave(); };

  inp.onchange = async e => {
    const file = e.target.files[0]; e.target.value = ''; // 같은 파일을 다시 골라도 다시 읽게
    if (!file || saving) return;
    const my = ++seq; clear(); say('결과 파일을 읽는 중…');
    let R;
    try {
      let data;
      try { data = JSON.parse(await file.text()); } catch { throw new Error('JSON 파일이 아니에요. 분석이 끝나고 생긴 결과 파일(…-결과.json)을 골라 주세요.'); }
      let check;
      try { check = (await import('./analysis-file.js')).parseAnalysisFile; } catch { throw new Error('결과 파일 검사 도구(js/analysis-file.js)를 불러오지 못했어요. 새로고침해 보세요.'); }
      if (typeof check !== 'function') throw new Error('결과 파일 검사 도구가 아직 준비되지 않았어요.');
      R = check(data); // 형식이 틀리면 한국어 오류
    } catch (err) { if (my === seq && !isLeft()) say('가져올 수 없어요: ' + err.message, true, true); return; }
    if (my !== seq || isLeft()) return; // 그사이 다른 파일을 골랐거나 화면을 떠남
    picked = { R, fileName: file.name };
    showPreview();
  };

  function showPreview() {
    const { R, fileName } = picked, res = R.result, se = R.session || {};
    const teams = (res.teams || []).map((t, k) => `${esc(t.name)} ${res.players.filter(p => p.team === k).length}명`).join(' · ');
    const src = typeof R.analysis?.sourceName === 'string' ? R.analysis.sourceName : ''; // 원본 영상 이름은 analysis.sourceName (검사기가 최상위 칸은 버림)
    const rows = [['수업', se.title || `${se.date} 수업`], ['날짜', se.date], ['영상 길이', fmtTime(res.duration)], ['팀·아이', null, teams || '–'],
      ['원본 영상', src || '(이름 없음)'], ['분석 방식', engineText(R.analysis?.engine)], ['결과 파일', fileName]];
    $('#impSum').innerHTML = rows.map(([k, text, html]) => `<dt>${k}</dt><dd>${html ?? esc(text ?? '–')}</dd>`).join('');
    // 반: 작업을 만든 반이 이 브라우저에 있으면 그 반, 없으면(다른 컴퓨터·브라우저에서 만든 작업) 직접 고르게
    const known = groups.some(g => g.id === se.groupId);
    selG.innerHTML = '<option value="">반 고르기</option>' + org.schools.filter(sc => sc.id !== store.UNSORTED).map(sc => {
      const gs = groups.filter(g => g.schoolId === sc.id);
      return gs.length ? `<optgroup label="${esc(sc.name)}">${gs.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    selG.value = known ? se.groupId : '';
    note.innerHTML = !groups.length ? '아직 반이 없어요. 먼저 <a href="#orgs">학교·반</a>에서 학교와 반을 만든 뒤, 이 결과 파일을 다시 골라 주세요.'
      : known ? '작업 설정 파일을 만들 때 고른 반이에요. 다른 반이면 바꿔 주세요.'
      : '이 결과를 만든 반을 이 브라우저에서 찾지 못했어요(다른 컴퓨터나 브라우저에서 만든 작업일 수 있어요). 어느 반 수업인지 골라 주세요.';
    box.hidden = false; syncSave();
    say(groups.length ? '내용을 확인하고 반을 고른 뒤 수업 기록으로 추가하세요.' : '', false);
  }
  selG.onchange = syncSave;
  $('#impCancel').onclick = () => { if (saving) return; seq++; clear(); say(''); };

  save.onclick = async () => {
    if (saving || !picked || !selG.value) return; // 중복 클릭 방지
    const { R } = picked, groupId = selG.value;
    saving = true; syncSave(); say('수업 기록으로 저장하는 중…');
    try {
      // 저장 직전에 반이 아직 있는지 다시 본다 (다른 화면·탭에서 지운 반에 기록이 붙지 않게)
      if (!(await store.listGroups()).some(g => g.id === groupId && g.id !== store.UNSORTED)) {
        groups.splice(0, groups.length, ...groups.filter(g => g.id !== groupId));
        [...selG.options].find(o => o.value === groupId)?.remove(); selG.value = '';
        throw new Error('고른 반이 지워졌어요. 다른 반을 골라 주세요.');
      }
      let id = store.uid(); while (await store.getSession(id)) id = store.uid(); // 늘 새 번호 → 이미 있는 기록을 덮어쓰지 않음
      const date = R.session.date, title = String(R.session.title || '').trim() || `${date} 수업`;
      await store.putSession({ id, createdAt: new Date().toISOString(), title, date, groupId, assign: {}, result: R.result, analysis: R.analysis });
      picked = null; // 저장 끝: 같은 결과를 또 저장하지 않게 (화면을 옮기기 전 다시 눌러도 무시)
      if (isLeft()) return; // 그사이 다른 화면으로 갔으면 끌고 가지 않음 (기록은 저장됨)
      location.hash = '#s-' + id; // 바로 검수·교정·전술 분석
    } catch (err) {
      if (!isLeft()) say('저장하지 못했어요: ' + err.message + ' 다시 눌러 보세요.', true, true);
    } finally {
      saving = false; if (!isLeft()) syncSave();
    }
  };
  syncSave();
}
