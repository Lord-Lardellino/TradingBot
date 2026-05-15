/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0f0f17',
          50: '#13131e',
          100: '#1a1a28',
          200: '#22223a',
          300: '#2d2d45',
        },
        brand: {
          DEFAULT: '#7c3aed',
          light: '#a78bfa',
        },
        profit: '#22c55e',
        loss: '#ef4444',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
