/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // タイトル専用。読み込みに失敗しても端末のフォントで表示され、崩れない。
      fontFamily: {
        display: ['"Kaisei Decol"', '"Hiragino Mincho ProN"', '"Yu Mincho"', 'serif'],
      },
      // 全画面共通の昭和レトロ色。印刷物は墨と朱の二色が基本で、紫や水色は出てこない。
      colors: {
        sumi: '#241c17',
        usuzumi: '#6b5f52',
        shu: '#b8352c',
        kinari: '#f7f1e3',
        kei: '#cdbfa4',
      },
    },
  },
  plugins: [],
}
