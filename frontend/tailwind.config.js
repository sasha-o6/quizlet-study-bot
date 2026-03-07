/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        quizlet: {
          blue: '#4255ff',
          darkBlue: '#2836b8',
          bgLite: '#f6f7fb',
          bgDark: '#0a092d',
          cardLite: '#ffffff',
          cardDark: '#2e3856',
          textLite: '#1a1d28',
          textDark: '#f0f1f3',
          gray: '#939bb4',
        }
      },
      fontFamily: {
        sans: ['"Inter"', 'sans-serif']
      }
    },
  },
  plugins: [],
}
