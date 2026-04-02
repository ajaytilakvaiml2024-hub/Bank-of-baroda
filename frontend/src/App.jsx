import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

const API = 'http://127.0.0.1:8000'

// ── helpers ───────────────────────────────────────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis) return
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang  = 'en-IN'
  utt.rate  = 0.88
  utt.pitch = 1
  // prefer a female voice
  const voices = window.speechSynthesis.getVoices()
  const preferred = voices.find(v => /female|woman|zira|hazel|heera/i.test(v.name))
    || voices.find(v => v.lang === 'en-IN')
    || voices[0]
  if (preferred) utt.voice = preferred
  window.speechSynthesis.speak(utt)
}

function timeNow() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null

// ── STATUS BOX ────────────────────────────────────────────────────────────────
function StatusBox({ state, message, sub }) {
  const iconMap = {
    idle:        '👋',
    listening:   '🎤',
    processing:  null,
    success:     '✅',
    error:       '⚠️',
    confirming:  '🔐',
  }

  return (
    <div className={`status-box ${state}`} role="status" aria-live="polite">
      <div>
        {state === 'processing' ? (
          <div className="typing-dots" aria-label="Processing">
            <span /><span /><span />
          </div>
        ) : (
          <>
            <span className="status-icon">{iconMap[state]}</span>
            <p className="status-message">{message}</p>
            {sub && <p className="status-sub">{sub}</p>}
          </>
        )}
      </div>
    </div>
  )
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function App() {
  const [balance, setBalance]         = useState(null)
  const [uiState, setUiState]         = useState('idle')   // idle | listening | processing | success | error | confirming
  const [statusMsg, setStatusMsg]     = useState('Hello! Tap the mic and speak a command.')
  const [statusSub, setStatusSub]     = useState('Say "What is my balance" or "Send 200 to Ravi"')
  const [transcript, setTranscript]   = useState('')
  const [pendingTx, setPendingTx]     = useState(null)     // { token, amount, recipient, audioPrompt }
  const [history, setHistory]         = useState([])
  const [listening, setListening]     = useState(false)
  const [speechSupported]             = useState(!!SpeechRecognition)
  const recRef = useRef(null)

  // Fetch balance on mount
  useEffect(() => {
    fetchBalance()
    // pre-load voices
    if (window.speechSynthesis) {
      window.speechSynthesis.getVoices()
      window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices()
    }
  }, [])

  async function fetchBalance(announce = false) {
    try {
      const res  = await fetch(`${API}/api/balance`)
      const data = await res.json()
      setBalance(data.balance)
      if (announce) {
        setUiState('success')
        setStatusMsg(data.audio_prompt)
        setStatusSub(null)
        speak(data.audio_prompt)
        addHistory({ icon: '💰', desc: 'Balance Enquiry', amount: null, type: 'info' })
        setTimeout(resetIdle, 5000)
      }
    } catch {
      setBalance(null)
    }
  }

  function resetIdle() {
    setUiState('idle')
    setStatusMsg('Hello! Tap the mic and speak a command.')
    setStatusSub('Say "What is my balance" or "Send 200 to Ravi"')
    setTranscript('')
    setPendingTx(null)
  }

  function addHistory(item) {
    setHistory(prev => [{ ...item, time: timeNow(), id: Date.now() }, ...prev].slice(0, 8))
  }

  // ── Voice recognition ──────────────────────────────────────────────────────
  const startListening = useCallback(() => {
    if (!SpeechRecognition) return
    if (recRef.current) { recRef.current.abort(); recRef.current = null }

    const rec = new SpeechRecognition()
    rec.lang            = 'en-IN'
    rec.continuous      = false
    rec.interimResults  = true
    rec.maxAlternatives = 1

    rec.onstart = () => {
      setListening(true)
      setUiState('listening')
      setStatusMsg('Listening… speak your command')
      setStatusSub(null)
      setTranscript('')
    }

    rec.onresult = (e) => {
      const interim = Array.from(e.results)
        .map(r => r[0].transcript)
        .join(' ')
      setTranscript(interim)
    }

    rec.onerror = (e) => {
      setListening(false)
      if (e.error === 'no-speech') {
        setUiState('idle')
        setStatusMsg('No speech detected. Please try again.')
        setStatusSub(null)
      } else {
        setUiState('error')
        setStatusMsg(`Mic error: ${e.error}`)
        setStatusSub(null)
        setTimeout(resetIdle, 3000)
      }
    }

    rec.onend = () => {
      setListening(false)
      const finalText = recRef.current?._finalText
      if (finalText) handleVoiceCommand(finalText)
      recRef.current = null
    }

    // capture final result before end fires
    rec.onnomatch = () => {
      setListening(false)
      setUiState('idle')
      setStatusMsg("Couldn't catch that. Please try again.")
      setStatusSub(null)
    }

    // override onresult to capture final
    const origOnResult = rec.onresult
    rec.onresult = (e) => {
      origOnResult(e)
      if (e.results[e.results.length - 1].isFinal) {
        rec._finalText = e.results[e.results.length - 1][0].transcript
      }
    }

    recRef.current = rec
    rec.start()
  }, [])

  const stopListening = useCallback(() => {
    recRef.current?.stop()
  }, [])

  function toggleMic() {
    if (listening) {
      stopListening()
    } else if (uiState !== 'processing' && uiState !== 'confirming') {
      startListening()
    }
  }

  // ── Intent flow ────────────────────────────────────────────────────────────
  async function handleVoiceCommand(text) {
    if (!text.trim()) { resetIdle(); return }

    setTranscript(text)
    setUiState('processing')
    setStatusMsg(null)

    try {
      const res  = await fetch(`${API}/api/intent/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json()

      if (data.intent === 'CHECK_BALANCE') {
        await fetchBalance(true)

      } else if (data.intent === 'TRANSFER_FUNDS') {
        await initiateTransfer(data.details.amount, data.details.recipient)

      } else {
        const msg = data.message || "I didn't understand. Please try again."
        setUiState('error')
        setStatusMsg(msg)
        setStatusSub(null)
        speak(msg)
        setTimeout(resetIdle, 4000)
      }
    } catch {
      setUiState('error')
      setStatusMsg('Cannot reach the server. Please check your connection.')
      setStatusSub(null)
      speak('Cannot reach the server.')
      setTimeout(resetIdle, 4000)
    }
  }

  async function initiateTransfer(amount, recipient) {
    try {
      const res  = await fetch(`${API}/api/transaction/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, recipient }),
      })
      const data = await res.json()

      if (data.status === 'pending_confirmation') {
        setPendingTx({ token: data.token, amount, recipient, audioPrompt: data.audio_prompt })
        setUiState('confirming')
        setStatusMsg(data.audio_prompt)
        setStatusSub('Tap Yes to confirm, or No to cancel.')
        speak(data.audio_prompt)
      } else {
        setUiState('error')
        setStatusMsg(data.audio_prompt || data.message)
        setStatusSub(null)
        speak(data.audio_prompt || data.message)
        setTimeout(resetIdle, 4000)
      }
    } catch {
      setUiState('error')
      setStatusMsg('Could not start the transfer. Please try again.')
      setStatusSub(null)
      speak('Could not start the transfer.')
      setTimeout(resetIdle, 4000)
    }
  }

  async function confirmTransaction(yes) {
    if (!pendingTx) return
    if (!yes) {
      speak('Transfer cancelled. Stay safe!')
      addHistory({ icon: '❌', desc: `Cancelled: ₹${pendingTx.amount} to ${cap(pendingTx.recipient)}`, amount: null, type: 'info' })
      resetIdle()
      return
    }

    setUiState('processing')
    setStatusMsg(null)
    try {
      const res  = await fetch(`${API}/api/transaction/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: pendingTx.token }),
      })
      const data = await res.json()

      if (data.status === 'success') {
        setBalance(data.new_balance)
        setUiState('success')
        setStatusMsg(data.audio_prompt)
        setStatusSub(null)
        speak(data.audio_prompt)
        addHistory({
          icon: '💸',
          desc: `Sent to ${cap(pendingTx.recipient)}`,
          amount: `-₹${pendingTx.amount}`,
          type: 'debit',
        })
        setTimeout(resetIdle, 6000)
      } else {
        setUiState('error')
        const msg = data.audio_prompt || data.message
        setStatusMsg(msg)
        setStatusSub(null)
        speak(msg)
        setTimeout(resetIdle, 4000)
      }
    } catch {
      setUiState('error')
      setStatusMsg('Transfer failed. Please try again.')
      setStatusSub(null)
      speak('Transfer failed.')
      setTimeout(resetIdle, 4000)
    }
  }

  function quickAction(cmd) {
    handleVoiceCommand(cmd)
    setTranscript(cmd)
  }

  const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : ''

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-brand">
          <div className="header-logo" aria-hidden="true">🏦</div>
          <div>
            <div className="header-title">Bank of Baroda</div>
            <div className="header-subtitle">Voice Assistant</div>
          </div>
        </div>
        <div className="security-badge">
          <div className="security-dot" aria-hidden="true" />
          Secured
        </div>
      </header>

      {/* Greeting */}
      <section className="greeting">
        <p className="greeting-name">Welcome back,</p>
        <h1 className="greeting-text">Elderly <span>User</span> 👋</h1>
      </section>

      {/* Balance Card */}
      <div className="balance-card" aria-label="Account Balance">
        <div className="balance-label">Available Balance</div>
        {balance !== null ? (
          <>
            <div className="balance-amount">
              <span className="currency">₹</span>
              {balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
            <div className="balance-updated">Account: ••••• 7832 &nbsp;|&nbsp; Updated just now</div>
          </>
        ) : (
          <div className="balance-loading">
            <span>Loading balance…</span>
          </div>
        )}
      </div>

      {/* No Speech API banner */}
      {!speechSupported && (
        <div className="no-speech-banner" role="alert">
          ⚠️ Your browser doesn't support voice recognition. Please use Chrome or Edge.
        </div>
      )}

      {/* Status */}
      <StatusBox state={uiState} message={statusMsg} sub={statusSub} />

      {/* Transcript */}
      {transcript && (
        <div className="transcript" aria-label="Recognized speech">
          🗣️ "{transcript}"
        </div>
      )}

      {/* Confirmation Panel */}
      {uiState === 'confirming' && pendingTx && (
        <div className="confirm-panel" role="dialog" aria-label="Confirm Transaction">
          <div className="confirm-title">🔐 Confirm Transfer</div>
          <div className="confirm-row">
            <span className="confirm-row-label">Send to</span>
            <span className="confirm-row-value">{cap(pendingTx.recipient)}</span>
          </div>
          <div className="confirm-row">
            <span className="confirm-row-label">Amount</span>
            <span className="confirm-row-value amount">₹ {pendingTx.amount.toLocaleString('en-IN')}</span>
          </div>
          <div className="confirm-actions">
            <button
              id="btn-confirm-yes"
              className="btn-confirm yes"
              onClick={() => confirmTransaction(true)}
              aria-label="Yes, confirm transfer"
            >
              ✅ Yes, Send
            </button>
            <button
              id="btn-confirm-no"
              className="btn-confirm no"
              onClick={() => confirmTransaction(false)}
              aria-label="No, cancel transfer"
            >
              ❌ Cancel
            </button>
          </div>
        </div>
      )}

      {/* Mic Button */}
      {uiState !== 'confirming' && (
        <div className="mic-area">
          <button
            id="mic-button"
            className={`mic-button ${listening ? 'listening' : ''}`}
            onClick={toggleMic}
            disabled={!speechSupported || uiState === 'processing'}
            aria-label={listening ? 'Stop listening' : 'Start voice command'}
            aria-pressed={listening}
          >
            {listening ? '🔴' : '🎙️'}
          </button>
          <div>
            <div className="mic-label">
              {listening ? 'Tap to stop' : 'Tap to speak'}
            </div>
            <div className="mic-hint">
              {listening ? 'Speak now…' : 'Ask anything about your account'}
            </div>
          </div>
        </div>
      )}

      {/* Quick Actions */}
      {uiState === 'idle' && (
        <section className="quick-actions" aria-labelledby="quick-title">
          <div className="section-title" id="quick-title">Quick Commands</div>
          <div className="quick-grid">
            <button
              id="quick-balance"
              className="quick-btn"
              onClick={() => quickAction('What is my balance')}
            >
              <span className="quick-btn-icon">💰</span>
              <span className="quick-btn-label">Check Balance</span>
            </button>
            <button
              id="quick-send-ravi"
              className="quick-btn"
              onClick={() => quickAction('send 200 to ravi')}
            >
              <span className="quick-btn-icon">💸</span>
              <span className="quick-btn-label">Send to Ravi</span>
            </button>
            <button
              id="quick-send-simran"
              className="quick-btn"
              onClick={() => quickAction('send 500 to simran')}
            >
              <span className="quick-btn-icon">👩</span>
              <span className="quick-btn-label">Send to Simran</span>
            </button>
            <button
              id="quick-help"
              className="quick-btn"
              onClick={() => {
                const msg = 'You can say: What is my balance, or Send 200 to Ravi. I am here to help!'
                setUiState('idle')
                setStatusMsg(msg)
                setStatusSub(null)
                speak(msg)
              }}
            >
              <span className="quick-btn-icon">❓</span>
              <span className="quick-btn-label">Help</span>
            </button>
          </div>
        </section>
      )}

      {/* Activity History */}
      {history.length > 0 && (
        <section className="history" aria-labelledby="history-title">
          <div className="section-title" id="history-title">Recent Activity</div>
          <ul className="history-list">
            {history.map(item => (
              <li key={item.id} className="history-item">
                <div className="history-item-left">
                  <div className={`history-item-icon ${item.type}`} aria-hidden="true">
                    {item.icon}
                  </div>
                  <div>
                    <div className="history-item-desc">{item.desc}</div>
                    <div className="history-item-time">{item.time}</div>
                  </div>
                </div>
                {item.amount && (
                  <div className={`history-item-amount ${item.type}`}>{item.amount}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Footer */}
      <footer className="footer">
        🔒 256-bit encrypted &nbsp;·&nbsp; Zero-trust session &nbsp;·&nbsp; Bank of Baroda © 2026
      </footer>
    </div>
  )
}
