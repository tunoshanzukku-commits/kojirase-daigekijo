// ジャンルの差し色。帯・罫・強調文字の色として使う。
// 昭和の印刷物は紙が地で、色は差し色。全面グラデは当時の印刷では刷れない。
// 生成り(#f7f1e3)の文字を載せる前提なので、コントラスト比 4.5:1 を切る明るい色は選べない。
export const GENRE_ACCENT: Record<string, string> = {
  romance: '#9d4448', // 紅梅
  horror:  '#2f4550', // 藍鉄
  comedy:  '#8a6519', // 山吹
  jidai:   '#46603f', // 深緑
  sf:      '#3a4f7a', // 群青
  mystery: '#5f4c6b', // 葡萄鼠
  emotion: '#3f6b67', // 錆浅葱
  chaos:   '#b8352c', // 朱
}

/** ジャンル未選択（トップ・ロビー）では墨。 */
export const DEFAULT_ACCENT = '#241c17'
