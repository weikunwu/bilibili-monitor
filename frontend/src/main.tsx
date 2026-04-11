import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { CustomProvider } from 'rsuite'
import 'rsuite/dist/rsuite-no-reset.min.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CustomProvider theme="dark">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </CustomProvider>
  </StrictMode>,
)
