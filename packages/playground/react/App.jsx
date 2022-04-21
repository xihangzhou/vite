import { useState } from 'react'
import styles from './index.less'

function App() {
  const [count, setCount] = useState(0)
  return (
    <div className="App">
      <header className="App-header">
        <h1 className={styles.text}>Hello Vite + React</h1>
        <p>
          <button onClick={() => setCount((count) => count + 1)}>
            count {count}
          </button>
        </p>
        <p>
          <code>App.jsx</code> and save to test HMR updates.
        </p>
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>
    </div>
  )
}

export default App
