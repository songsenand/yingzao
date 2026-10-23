// "Where do I look next?" — the pointer a judge-mode reply owes the reader.
//
// WHY (HARNESS §11.14, DESIGN §25.7): a verdict without a place is "把找缺陷的活退回给使用者".
// `check_printability` and `simulate_stress` trim the per-sample field out of their default
// (`judge`) reply on purpose — the field is a picture for a human and noise in the model's
// context — but trimming it silently left the model with a verdict and nowhere to go
// (2026-10-23 audit, FIX-B3). The fix is not to re-add the field: it is to make every
// judge-mode verdict carry a RUNNABLE next observation, which is what §11.14 actually asks
// for ("坐标 + 为什么 + 一条可执行的观测命令").
//
// The commands name real tools and real arguments. A pointer that cannot be pasted into a
// tool call is a suggestion, not an observation.

import type { Judgement } from '../shared/judgement.ts';

export interface NextLook {
  /** Tool to call. */
  tool: string;
  /** Arguments to call it with. */
  args: Record<string, unknown>;
  /** Why this is where to look — one sentence, tied to the verdict. */
  why: string;
}

/**
 * The next observations for a verdict about one saved version.
 *
 * Deterministic on purpose: the same version and verdict always yield the same pointers,
 * so a test can pin them and a reader can trust that the tool is not improvising.
 */
export function nextLookFor(input: {
  source: 'printability' | 'stress';
  versionId: string;
  judgement: Judgement;
}): NextLook[] {
  const { source, versionId, judgement } = input;
  const scanFor = (what: string): NextLook => ({
    tool: 'check_printability',
    args: { versionId, mode: 'scan' },
    why: `判定的分样场被 judge 模式裁掉了；${what}在那份场里（峰 + 每点值 + 可执行观测）`,
  });
  if (source === 'printability') {
    return [
      scanFor('壁厚与悬垂的峰值位置'),
      {
        tool: 'analyze',
        args: { versionId },
        why: '融合风险图（|u|，壁厚 / 再入角 / 悬垂三路取 max）——一屏指出最该看的几处',
      },
    ];
  }
  // stress: the measurement is only as good as where the geometry concentrates it.
  return [
    {
      tool: 'scan_attention',
      args: { versionId },
      why: judgement === 'difficult'
        ? '没有可认证的热点：先看几何再入角（应力起裂处），它比"没有结果"更接近答案'
        : '应力峰的位置由几何决定；再入角是它常起的地方',
    },
    scanFor('壁厚——薄截面是应力估计最不可信的地方'),
  ];
}
