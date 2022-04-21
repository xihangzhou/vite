import react from '@vitejs/plugin-react'
import viteCssModule from './css-module-resolver'
import type { UserConfig } from 'vite'

const config: UserConfig = {
  plugins: [...viteCssModule(), react()],
  build: {
    // to make tests faster
    minify: false
  },
  server: {
    force: true
  }
}

export default config
