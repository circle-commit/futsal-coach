// 로컬 분석 명령 (영상은 이 컴퓨터에서만 읽음). 본체는 tools/local-analysis.mjs
//   node tools/analyze.mjs <영상 파일> <작업 설정 파일.json> <결과 파일.json> [--engine classical-v1|classical-v2] [--resume]
//   node tools/analyze.mjs --help
// 예전처럼 작업 설정 대신 분석 설정(cfg) JSON을 주면 분석 결과(result)만 저장한다 (결과 파일 생략 가능, 개발·검증용).
import { main } from './local-analysis.mjs';

process.exitCode = await main(process.argv.slice(2));
