import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/geist'
import '@nessie/sign-in-surface/tokens.css'
import '@nessie/sign-in-surface/styles.css'
import { App } from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
