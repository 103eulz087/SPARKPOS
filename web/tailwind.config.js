/** @type {import('tailwindcss').Config} */
// "Night counter" theme: a dark ground with the SparkPOS green as the action color and the
// logo's blue as a second accent. Use these names, not raw stone/emerald shades, in new UI.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0B1220',      // page background
        deep: '#080D19',     // bars that sit below/above the page (totals, toasts)
        panel: '#121B2E',    // cards, sidebars, modals
        raised: '#18233A',   // inputs on a panel, hover, secondary surfaces
        hover: '#1E2A44',
        line: '#24324F',     // borders and dividers
        line2: '#3A4A6B',    // input and button borders
        fg: '#F1F5F9',       // main text
        fg2: '#C7D2E2',      // secondary text
        muted: '#8B9AB2',    // labels, hints (≥4.5:1 on ink and panel)
        subtle: '#5B6B88',   // decoration only, never text people must read
        accent: { DEFAULT: '#6DB33F', hover: '#7CC24C', fg: '#93CF68' },   // SparkPOS green
        brand: { DEFAULT: '#0B5CB5', fg: '#6FAEF0' },                       // SparkPOS blue
        danger: { DEFAULT: '#DC2626', fg: '#FF8A8A' },
        warn: { DEFAULT: '#D9A21B', fg: '#F5C46B' }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Montserrat', 'Inter', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
}
