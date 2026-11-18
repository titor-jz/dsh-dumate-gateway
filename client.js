// Client half: a right-sidebar panel for the DuMate gateway.
//
// No build step: the browser module table supplies React. The panel first asks
// the host for a snapshot over the same-origin `/api` Fetch route, because the
// page's own policy may refuse a cross-origin call to 127.0.0.1:7321. Only when
// that route is missing does it fall back to the loopback HTTP gateway.
//
// Layout, top to bottom: status strip, usage chart, latency sparkline, try-it
// card, quick actions, then two collapsed drawers (models, diagnostics). Charts
// are hand-drawn inline SVG: the package is dependency-free and must follow the
// host theme, so no charting library and no hardcoded palette — everything is
// currentColor plus an accent.
window.__ModuleLoader__.load({
  id: 'dsh-dumate-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TAB_ID = 'dsh-dumate-gateway'
    const KIND = 'dumateGateway'
    const GATEWAY = 'http://127.0.0.1:7321'
    const STATUS = '/api/dumate-gateway/status'
    const TRY = '/api/dumate-gateway/try'
    const HEADLESS = '/api/dumate-gateway/headless'
    const REFRESH_MS = 15000
    const NS = 'dumateGateway'
    const FAVORITES_KEY = 'dsh.dumate-gateway.favorites.v1'
    const LATENCY_KEY = 'dsh.dumate-gateway.latency.v1'
    const LATENCY_KEEP = 12
    const MODEL_KEY = 'dsh.dumate-gateway.model.v1'
    const ACCENT = '#4a7dff'

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 14px 22px',
        font: 'inherit',
        color: 'inherit',
        overflowY: 'auto',
        height: '100%',
        boxSizing: 'border-box',
      },
      strip: { display: 'flex', alignItems: 'center', gap: '8px', minHeight: '22px' },
      dot: { width: '7px', height: '7px', borderRadius: '50%', flex: '0 0 auto' },
      statusText: { fontSize: '12px', fontWeight: 600, letterSpacing: '0.01em', margin: 0 },
      spacer: { flex: '1 1 auto' },
      ghost: {
        font: 'inherit',
        fontSize: '11px',
        padding: '2px 7px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: 0.85,
        whiteSpace: 'nowrap',
      },
      card: {
        border: '1px solid rgba(127,127,127,0.18)',
        borderRadius: '10px',
        padding: '10px 12px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        background: 'rgba(127,127,127,0.03)',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      label: {
        margin: 0,
        fontSize: '10.5px',
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        opacity: 0.55,
      },
      big: { margin: 0, fontSize: '22px', fontWeight: 650, lineHeight: 1.15, letterSpacing: '-0.01em' },
      bigUnit: { fontSize: '11.5px', fontWeight: 500, opacity: 0.55, marginLeft: '4px' },
      meta: { font: 'inherit', fontSize: '11px', opacity: 0.68, margin: 0, lineHeight: 1.5 },
      propTrack: {
        display: 'flex',
        gap: '2px',
        height: '6px',
        borderRadius: '999px',
        background: 'rgba(127,127,127,0.13)',
        overflow: 'hidden',
        margin: '2px 0 0',
      },
      propIn: { background: ACCENT, opacity: 0.42, borderRadius: '999px' },
      propOut: { background: ACCENT, borderRadius: '999px' },
      legendRow: { display: 'flex', alignItems: 'center', gap: '10px' },
      legend: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '10.5px', opacity: 0.72 },
      dotIn: { width: '6px', height: '6px', borderRadius: '50%', background: ACCENT, opacity: 0.42, display: 'inline-block' },
      dotOut: { width: '6px', height: '6px', borderRadius: '50%', background: ACCENT, display: 'inline-block' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
      row: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
      statBlock: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: '64px' },
      statValue: { fontSize: '15px', fontWeight: 600, letterSpacing: '-0.01em' },
      statLabel: { fontSize: '10px', opacity: 0.55, letterSpacing: '0.04em', textTransform: 'uppercase' },
      search: {
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'transparent',
        color: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      },
      list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
      modelPick: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      select: {
        font: 'inherit',
        fontSize: '11px',
        color: 'inherit',
        background: 'transparent',
        border: '1px solid rgba(127,127,127,0.28)',
        borderRadius: '6px',
        padding: '2px 4px',
        maxWidth: '100%',
      },
      modelRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 7px',
        borderRadius: '6px',
        border: '1px solid transparent',
        font: 'inherit',
        fontSize: '11.5px',
        color: 'inherit',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        boxSizing: 'border-box',
      },
      star: {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: 0.7,
        flex: '0 0 auto',
      },
      modelName: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      dim: { opacity: 0.55, fontSize: '10.5px', whiteSpace: 'nowrap' },
      empty: { font: 'inherit', fontSize: '11.5px', opacity: 0.7, lineHeight: 1.6, margin: 0 },
      warn: {
        font: 'inherit',
        fontSize: '11.5px',
        lineHeight: 1.6,
        margin: 0,
        color: '#d97706',
      },
      detailsRow: {
        display: 'grid',
        gridTemplateColumns: '72px 1fr',
        columnGap: '8px',
        rowGap: '3px',
        fontSize: '11px',
        margin: 0,
      },
      detailsKey: { opacity: 0.55, whiteSpace: 'nowrap' },
      detailsValue: { overflowWrap: 'anywhere' },
      actions: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      input: {
        font: 'inherit',
        fontSize: '12px',
        padding: '6px 8px',
        borderRadius: '7px',
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'transparent',
        color: 'inherit',
        width: '100%',
        boxSizing: 'border-box',
      },
      send: {
        font: 'inherit',
        fontSize: '11.5px',
        fontWeight: 600,
        padding: '6px 12px',
        borderRadius: '7px',
        border: `1px solid ${ACCENT}`,
        background: ACCENT,
        color: '#fff',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      sendDisabled: { opacity: 0.55, cursor: 'default' },
      answer: {
        margin: 0,
        fontSize: '12px',
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight: '152px',
        overflowY: 'auto',
      },
      divider: { height: '1px', background: 'rgba(127,127,127,0.16)', border: 0, margin: 0 },
      drawerHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        width: '100%',
        textAlign: 'left',
      },
      caret: { fontSize: '10px', opacity: 0.6, width: '10px' },
      chip: {
        fontSize: '10.5px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.25)',
        opacity: 0.8,
        whiteSpace: 'nowrap',
      },
    }

    // ---------------------------------------------------------------- helpers

    function formatWindow(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      if (value >= 1000000) return `${Math.round(value / 100000) / 10}M`
      if (value >= 1000) return `${Math.round(value / 1000)}K`
      return String(value)
    }

    function formatMs(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
    }

    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0'
      if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
      if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
      return String(value)
    }

    // A reasoning model can spend the whole budget thinking, which would read as
    // an empty bubble. Fall back to the thinking text and label it.
    function shownAnswer(result) {
      if (typeof result?.text === 'string' && result.text !== '') return result.text
      if (typeof result?.reasoning === 'string' && result.reasoning !== '') {
        return `${result.reasoning}\n\n(thinking only — the token budget ran out before any answer)`
      }
      return '(empty reply)'
    }

    function localDayKey(date) {
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    function weekday(date) {
      return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()]
    }

    // Seven buckets ending today, so the chart has a fixed shape even when the
    // ledger is empty (empty days draw as a two-pixel stub).
    function lastSevenDays(usage) {
      const byDate = new Map()
      if (usage !== null && Array.isArray(usage.days)) {
        for (const day of usage.days) {
          if (typeof day?.date === 'string') byDate.set(day.date, day)
        }
      }
      const series = []
      const now = new Date()
      for (let offset = 6; offset >= 0; offset -= 1) {
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
        const key = localDayKey(date)
        const day = byDate.get(key)
        const input = typeof day?.input_tokens === 'number' ? day.input_tokens : 0
        const output = typeof day?.output_tokens === 'number' ? day.output_tokens : 0
        series.push({
          date: key,
          label: weekday(date),
          requests: typeof day?.requests === 'number' ? day.requests : 0,
          inputTokens: input,
          outputTokens: output,
          tokens: input + output,
          errors: typeof day?.errors === 'number' ? day.errors : 0,
          isToday: offset === 0,
        })
      }
      return series
    }

    function readList(key) {
      try {
        const raw = window.localStorage.getItem(key)
        const parsed = raw === null ? [] : JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }

    function writeList(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Blocked storage costs a favorite or a spark point, never the panel.
      }
    }

    function readString(key) {
      try {
        const raw = window.localStorage.getItem(key)
        return typeof raw === 'string' && raw !== '' ? raw : null
      } catch {
        return null
      }
    }

    function writeString(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        // Losing the remembered model just means the next attempt starts on auto.
      }
    }

    function readFavorites() {
      return readList(FAVORITES_KEY).filter(id => typeof id === 'string')
    }

    function readLatency() {
      return readList(LATENCY_KEY)
        .filter(point => point !== null && typeof point === 'object' && typeof point.ms === 'number')
        .slice(-LATENCY_KEEP)
    }

    function percentile(values, ratio) {
      if (values.length === 0) return null
      const sorted = [...values].sort((left, right) => left - right)
      const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
      return sorted[index]
    }

    // ------------------------------------------------------------------ atoms

    function Dot({ online }) {
      const color = online === true ? '#2e9e5b' : online === false ? '#c9483f' : 'rgba(127,127,127,0.55)'
      return h('span', { style: { ...styles.dot, background: color }, 'aria-hidden': true })
    }

    function Card({ children }) {
      return h('section', { style: styles.card }, children)
    }

    function Stat({ label, value }) {
      return h('div', { style: styles.statBlock },
        h('span', { style: styles.statValue }, value),
        h('span', { style: styles.statLabel }, label))
    }

    // ---------------------------------------------------------------- charts

    // Seven days of paired in/out bars: thin columns read as activity at a
    // glance, and today gets a soft band plus its own value label. Empty days
    // stay as a two-pixel tick so the baseline still reads as a time axis.
    // Seven slim days. Bars beat a line here: days are discrete events, and the
    // empty days have to read as "nothing happened", not as a dip in a curve.
    function UsageChart({ series }) {
      const width = 320
      const height = 88
      const top = 12
      const baseline = 64
      const plot = baseline - top
      const max = Math.max(0, ...series.map(day => day.tokens))
      const slot = width / series.length
      const barWidth = 6
      const gap = 3
      const groupWidth = barWidth * 2 + gap
      const today = series[series.length - 1]
      const heightsOf = day => ({
        input: max > 0 && day.inputTokens > 0 ? Math.max(2, Math.round((day.inputTokens / max) * plot)) : 0,
        output: max > 0 && day.outputTokens > 0 ? Math.max(2, Math.round((day.outputTokens / max) * plot)) : 0,
      })

      const bars = []
      series.forEach((day, index) => {
        const groupX = index * slot + (slot - groupWidth) / 2
        if (day.tokens === 0) {
          bars.push(h('rect', {
            key: day.date,
            x: groupX,
            y: baseline - 1.5,
            width: groupWidth,
            height: 2,
            rx: 1,
            fill: 'currentColor',
            opacity: 0.16,
          }))
          return
        }
        const { input, output } = heightsOf(day)
        bars.push(h('g', { key: day.date },
          input > 0 ? h('rect', {
            x: groupX,
            y: baseline - input,
            width: barWidth,
            height: input,
            rx: 2.5,
            fill: 'url(#dumate-gateway-in)',
            opacity: day.isToday ? 1 : 0.85,
          }) : null,
          output > 0 ? h('rect', {
            x: groupX + barWidth + gap,
            y: baseline - output,
            width: barWidth,
            height: output,
            rx: 2.5,
            fill: 'url(#dumate-gateway-out)',
            opacity: day.isToday ? 1 : 0.6,
          }) : null,
          h('title', null, `${day.date} · ${day.inputTokens} in + ${day.outputTokens} out · ${day.requests} requests`)))
      })

      const todayHeights = heightsOf(today)
      const todayTop = baseline - Math.max(todayHeights.input, todayHeights.output)
      const todayX = (series.length - 1) * slot + (slot - groupWidth) / 2

      return h('svg', {
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'xMidYMid meet',
        role: 'img',
        'aria-label': `Tokens per day over the last seven days; today ${today.tokens}`,
        style: { width: '100%', height: '88px', display: 'block', overflow: 'visible' },
      },
      h('defs', null,
        h('linearGradient', { id: 'dumate-gateway-in', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', stopColor: ACCENT, stopOpacity: 0.55 }),
          h('stop', { offset: '100%', stopColor: ACCENT, stopOpacity: 0.28 })),
        h('linearGradient', { id: 'dumate-gateway-out', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', stopColor: ACCENT, stopOpacity: 1 }),
          h('stop', { offset: '100%', stopColor: ACCENT, stopOpacity: 0.7 }))),
      max === 0 ? null : h('line', {
        x1: 0,
        y1: top + 0.5,
        x2: width,
        y2: top + 0.5,
        stroke: 'currentColor',
        strokeWidth: 0.5,
        strokeDasharray: '2 4',
        opacity: 0.18,
      }),
      max === 0 ? null : h('text', {
        x: 0,
        y: top - 2,
        textAnchor: 'start',
        fontSize: 8,
        fill: 'currentColor',
        opacity: 0.38,
        style: { fontVariantNumeric: 'tabular-nums' },
      }, formatTokens(max)),
      // The band frames today's bars and the value label above them, so the
      // highlight looks intentional instead of a box around empty space.
      h('rect', {
        x: todayX - 6,
        y: (today.tokens === 0 ? top : todayTop) - 20,
        width: groupWidth + 12,
        height: (today.tokens === 0 ? plot : baseline - todayTop) + 24,
        rx: 9,
        fill: ACCENT,
        opacity: 0.055,
      }),
      h('line', {
        x1: 0,
        y1: baseline + 0.5,
        x2: width,
        y2: baseline + 0.5,
        stroke: 'currentColor',
        strokeWidth: 0.5,
        opacity: 0.2,
      }),
      bars,
      today.tokens === 0 ? null : h('text', {
        x: todayX + groupWidth / 2,
        y: todayTop - 8,
        textAnchor: 'middle',
        fontSize: 9.5,
        fontWeight: 650,
        fill: ACCENT,
        style: { fontVariantNumeric: 'tabular-nums' },
      }, formatTokens(today.tokens)),
      series.map((day, index) => h('text', {
        key: `${day.date}-label`,
        x: index * slot + slot / 2,
        y: 82,
        textAnchor: 'middle',
        fontSize: 9,
        fontWeight: day.isToday ? 650 : 400,
        fill: 'currentColor',
        opacity: day.isToday ? 0.95 : 0.4,
      }, day.label)))
    }

    function LatencySpark({ points }) {
      const width = 120
      const height = 28
      if (points.length === 0) {
        return h('span', { style: styles.dim }, 'no samples yet')
      }
      const values = points.map(point => point.ms)
      const max = Math.max(1, ...values)
      const step = points.length === 1 ? 0 : width / (points.length - 1)
      const coords = values.map((value, index) => {
        const x = points.length === 1 ? width / 2 : index * step
        const y = height - 3 - (value / max) * (height - 8)
        return [Math.round(x * 10) / 10, Math.round(y * 10) / 10]
      })
      const last = coords[coords.length - 1]
      return h('svg', {
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': 'First-token latency, recent samples',
        style: { width: '120px', height: '28px', display: 'block', overflow: 'visible' },
      },
      h('polyline', {
        points: coords.map(pair => pair.join(',')).join(' '),
        fill: 'none',
        stroke: ACCENT,
        strokeWidth: 1.6,
        strokeLinejoin: 'round',
        strokeLinecap: 'round',
        opacity: 0.85,
      }),
      h('circle', { cx: last[0], cy: last[1], r: 2.1, fill: ACCENT }))
    }

    /**
     * The offline card that offers to start the two background processes.
     *
     * Pure, so the registration test can render each of its three shapes without
     * a live gateway: not running, starting, and unable to sign in.
     */
    function HeadlessCard({ headless, busy, error, onStart, onStop }) {
      if (headless === null || headless === undefined) return null
      return h(Card, null,
        h('div', { style: styles.cardHead },
          h('p', { style: styles.label }, headless.running ? 'Headless DuMate' : 'DuMate is not running'),
          h('span', { style: styles.spacer }),
          headless.running
            ? h('button', {
              type: 'button',
              style: styles.ghost,
              disabled: busy,
              title: 'Stop the two background processes this plugin started',
              onClick: onStop,
            }, busy ? 'Stopping…' : 'Stop')
            : h('button', {
              type: 'button',
              style: {
                ...styles.ghost,
                borderColor: ACCENT,
                color: ACCENT,
                opacity: busy ? 0.55 : 1,
              },
              disabled: busy,
              title: 'Start the two DuMate background processes without the desktop window',
              onClick: onStart,
            }, busy ? 'Starting…' : 'Start headless')),
        headless.running
          ? h('p', { style: styles.meta },
            'Two background processes are serving this gateway. The desktop window is not needed; memory stays around 60 MB instead of a gigabyte.')
          : h('p', { style: styles.meta },
            'Start only the two DuMate binaries this gateway needs — about 59 MB instead of the full app. The window stays closed.'),
        // Both backends up at once is the one state worth flagging: the desktop
        // app and these two processes write the same data directory, and nobody
        // has verified what DuMate does when that happens. Warn, never act.
        headless.running === true && typeof headless.desktopBaseURL === 'string'
          ? h('p', { style: styles.warn },
            `The DuMate desktop app is also running (${headless.desktopBaseURL}). Two backends share one data directory — close one of them to avoid trouble.`)
          : null,
        headless.signedIn === false
          ? h('p', { style: styles.empty }, 'Sign in to the DuMate app once first: headless mode reads the account it stored.')
          : null,
        error === null || error === undefined ? null : h('p', { style: styles.empty }, error))
    }

    // ------------------------------------------------------------------ panel

    function Panel() {
      const [state, setState] = React.useState({
        phase: 'loading',
        health: null,
        models: [],
        error: null,
        copied: null,
        query: '',
        favorites: [],
        readAt: null,
        prompt: '',
        model: '',
        attempt: null,
        probe: null,
        headless: null,
        headlessBusy: false,
        headlessError: null,
        latency: [],
        showModels: false,
        showDetails: false,
      })
      const alive = React.useRef(true)

      const load = React.useCallback(async () => {
        // Same-origin first: this route only answers the owner peer, so a page
        // served from any origin (including a remote GUI) can always read it.
        let health = null
        let models = []
        try {
          const response = await fetch(STATUS, { headers: { accept: 'application/json' } })
          if (response.ok) {
            health = await response.json()
            models = Array.isArray(health?.models) ? health.models : []
          }
        } catch {
          // Older host without the route: fall through to the HTTP gateway.
        }
        if (health === null) {
          try {
            const healthResponse = await fetch(`${GATEWAY}/health`)
            if (!healthResponse.ok) throw new Error(`health ${healthResponse.status}`)
            health = await healthResponse.json()
            if (health?.upstream?.online === true) {
              const modelsResponse = await fetch(`${GATEWAY}/v1/models`)
              if (modelsResponse.ok) {
                const payload = await modelsResponse.json()
                models = Array.isArray(payload?.data) ? payload.data : []
              }
            }
          } catch (error) {
            if (alive.current) {
              setState(prev => ({
                ...prev,
                phase: 'error',
                health: prev.health,
                models: prev.models,
                error: error instanceof Error ? error.message : String(error),
              }))
            }
            return
          }
        }
        if (alive.current) {
          setState(prev => ({
            ...prev,
            phase: 'ready',
            health,
            models,
            headless: health?.headless ?? null,
            error: null,
            readAt: new Date(),
          }))
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        setState(prev => ({
          ...prev,
          favorites: readFavorites(),
          latency: readLatency(),
          model: readString(MODEL_KEY) ?? '',
        }))
        load()
        const timer = setInterval(load, REFRESH_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const copy = React.useCallback(async (value, what) => {
        try {
          await navigator.clipboard.writeText(value)
          if (alive.current) setState(prev => ({ ...prev, copied: what }))
        } catch {
          // Clipboard permission is the page's business; a failure changes nothing here.
        }
      }, [])

      const star = React.useCallback(id => {
        setState(prev => {
          const favorites = prev.favorites.includes(id)
            ? prev.favorites.filter(item => item !== id)
            : [id, ...prev.favorites]
          writeList(FAVORITES_KEY, favorites)
          return { ...prev, favorites }
        })
      }, [])

      const send = React.useCallback(async () => {
        const prompt = state.prompt.trim()
        if (prompt === '' || state.attempt?.phase === 'running') return
        setState(prev => ({ ...prev, attempt: { phase: 'running' } }))
        try {
          const response = await fetch(TRY, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(state.model === '' ? { prompt } : { prompt, model: state.model }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.message ?? `try route returned ${response.status}`)
          }
          if (alive.current) {
            setState(prev => {
              const latency = typeof payload.first_token_ms === 'number'
                ? [...prev.latency, {
                  at: Date.now(),
                  ms: payload.first_token_ms,
                  model: payload.model,
                }].slice(-LATENCY_KEEP)
                : prev.latency
              writeList(LATENCY_KEY, latency)
              return { ...prev, attempt: { phase: 'done', result: payload }, latency }
            })
          }
        } catch (error) {
          if (alive.current) {
            setState(prev => ({
              ...prev,
              attempt: { phase: 'error', error: error instanceof Error ? error.message : String(error) },
            }))
          }
        }
        // The usage counters behind the status route just moved.
        load()
      }, [state.prompt, state.model, state.attempt, load])

      // One click, sixteen tokens: enough to prove the upstream answers, cheap
      // enough that a nervous user can press it as often as they like.
      const probeNow = React.useCallback(async () => {
        if (state.probe?.phase === 'running') return
        // The status route already knows whether DuMate is up: say so instead of
        // spending a round trip to collect a raw transport error.
        if (state.health?.upstream?.online === false) {
          setState(prev => ({
            ...prev,
            probe: { phase: 'error', error: 'DuMate is not running. Start the desktop app, then probe again.' },
          }))
          return
        }
        setState(prev => ({ ...prev, probe: { phase: 'running' } }))
        try {
          const body = state.model === ''
            ? { prompt: 'ping', max_tokens: 16 }
            : { prompt: 'ping', max_tokens: 16, model: state.model }
          const response = await fetch(TRY, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.message ?? `try route returned ${response.status}`)
          }
          if (alive.current) {
            // A probe measures the same first-token moment a real message does, so
            // it feeds the sparkline too — that way the card has samples before the
            // first real Send, without inventing traffic.
            setState(prev => {
              const latency = typeof payload.first_token_ms === 'number'
                ? [...prev.latency, {
                  at: Date.now(),
                  ms: payload.first_token_ms,
                  model: payload.model,
                }].slice(-LATENCY_KEEP)
                : prev.latency
              writeList(LATENCY_KEY, latency)
              return { ...prev, probe: { phase: 'done', result: payload }, latency }
            })
          }
        } catch (error) {
          if (alive.current) {
            setState(prev => ({
              ...prev,
              probe: { phase: 'error', error: error instanceof Error ? error.message : String(error) },
            }))
          }
        }
        load()
        // state.health is read by the offline guard above: keep it in the deps,
        // otherwise the callback keeps the first render's (null) health forever.
      }, [state.model, state.probe, state.health, load])

      /**
       * Headless mode: the two DuMate binaries without the Electron window.
       *
       * The panel only ever asks for an action — the host decides what starting
       * means. When `headless.autoStart` is on, the plugin has usually started it
       * already and this button just reports the state.
       */
      const callHeadless = React.useCallback(async action => {
        if (state.headlessBusy) return
        setState(prev => ({ ...prev, headlessBusy: true, headlessError: null }))
        try {
          const response = await fetch(HEADLESS, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ action }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.message ?? `headless route returned ${response.status}`)
          }
          if (alive.current) {
            setState(prev => ({ ...prev, headless: payload.headless ?? prev.headless }))
          }
        } catch (error) {
          if (alive.current) {
            setState(prev => ({
              ...prev,
              headlessError: error instanceof Error ? error.message : String(error),
            }))
          }
        }
        if (alive.current) setState(prev => ({ ...prev, headlessBusy: false }))
        load()
      }, [state.headlessBusy, load])

      const query = state.query.trim().toLowerCase()
      const matches = query.length === 0
        ? state.models
        : state.models.filter(model => {
          const haystack = [
            model.id,
            model.name,
            ...(Array.isArray(model.input_modalities) ? model.input_modalities : []),
          ].filter(part => typeof part === 'string').join(' ').toLowerCase()
          return haystack.includes(query)
        })
      const starred = matches.filter(model => state.favorites.includes(model.id))
      const ordered = [...starred, ...matches.filter(model => !state.favorites.includes(model.id))]

      const health = state.health
      const online = health?.upstream?.online ?? null
      const headlessState = state.headless
      const gatewayUp = health?.gateway?.version !== undefined
      const total = health?.upstream?.models ?? state.models.length
      const reason = typeof health?.reason === 'string' ? health.reason : null
      const baseURL = typeof health?.upstream?.baseURL === 'string' ? health.upstream.baseURL : null
      const configPath = typeof health?.upstream?.config_path === 'string' ? health.upstream.config_path : null
      const modelsMode = health?.gateway?.models_mode ?? null
      const usage = health?.usage ?? null
      const series = lastSevenDays(usage)
      const today = series[series.length - 1]
      const latency = state.latency
      const lastLatency = latency.length === 0 ? null : latency[latency.length - 1].ms
      const median = percentile(latency.map(point => point.ms), 0.5)
      const statusLabel = state.phase === 'error' ? 'No host' : online === true ? 'Online' : online === false ? 'Offline' : 'Probing'

      const refresh = h('button', {
        type: 'button',
        style: styles.ghost,
        onClick: load,
        title: 'Read the host again now',
      }, 'Refresh')

      return h('div', { style: styles.root },

        // ---------------------------------------------------------- status strip
        h('div', { style: styles.strip },
          h(Dot, { online }),
          h('p', { style: styles.statusText }, statusLabel),
          online === true ? h('span', { style: styles.chip }, `${total} models`) : null,
          headlessState?.running === true ? h('span', { style: styles.chip }, 'headless') : null,
          h('span', { style: styles.spacer }),
          h('span', { style: styles.dim }, gatewayUp ? `v${health.gateway.version}` : ''),
          refresh),

        state.phase === 'error'
          ? h(Card, null,
            h('p', { style: styles.label }, 'Panel offline'),
            h('p', { style: styles.empty },
              'The panel asked ',
              h('code', { style: styles.mono }, STATUS),
              ' and then ',
              h('code', { style: styles.mono }, GATEWAY),
              '. Make sure DSH runs and the plugin is enabled.'),
            h('p', { style: { ...styles.empty, ...styles.mono } }, state.error ?? ''),
            h('div', { style: styles.actions }, refresh))
          : null,

        // ------------------------------------------------------ headless prompt
        // Shown when the gateway is offline (offer to start) and also while a
        // headless backend is serving (offer to stop it), never merely because
        // the desktop app is running.
        (online === false || headlessState?.running === true) && headlessState !== null
          ? h(HeadlessCard, {
            headless: headlessState,
            busy: state.headlessBusy,
            error: state.headlessError,
            onStart: () => callHeadless('start'),
            onStop: () => callHeadless('stop'),
          })
          : null,

        // ------------------------------------------------------------ usage card
        h(Card, null,
          h('div', { style: styles.cardHead },
            h('p', { style: styles.label }, 'Today'),
            h('span', { style: styles.spacer }),
            h('span', { style: styles.dim }, `${today.requests} req · ${today.errors} err`)),
          h('p', { style: styles.big },
            formatTokens(today.tokens),
            h('span', { style: styles.bigUnit }, 'tokens')),
          h('div', {
            style: styles.propTrack,
            role: 'img',
            'aria-label': `Today ${today.inputTokens} tokens in, ${today.outputTokens} out`,
          },
          today.inputTokens > 0 ? h('span', { style: { ...styles.propIn, flex: String(today.inputTokens) } }) : null,
          today.outputTokens > 0 ? h('span', { style: { ...styles.propOut, flex: String(today.outputTokens) } }) : null),
          today.tokens === 0
            ? h('p', { style: styles.meta }, 'No requests yet today.')
            : h('div', { style: styles.legendRow },
              h('span', { style: styles.legend },
                h('span', { style: styles.dotIn }), `in ${formatTokens(today.inputTokens)}`),
              h('span', { style: styles.legend },
                h('span', { style: styles.dotOut }), `out ${formatTokens(today.outputTokens)}`),
              h('span', { style: styles.spacer }),
              h('span', { style: styles.dim }, 'last 7 days')),
          h(UsageChart, { series })),

        // ---------------------------------------------------------- latency card
        h(Card, null,
          h('div', { style: styles.cardHead },
            h('p', { style: styles.label }, 'First token'),
            h('span', { style: styles.spacer }),
            h(LatencySpark, { points: latency })),
          h('div', { style: styles.row },
            h(Stat, { label: 'last', value: formatMs(lastLatency) }),
            h(Stat, { label: 'p50', value: formatMs(median) }),
            h(Stat, { label: 'samples', value: String(latency.length) }))),

        // -------------------------------------------------------------- try card
        h(Card, null,
          h('div', { style: styles.cardHead },
            h('p', { style: styles.label }, 'Try it'),
            h('span', { style: styles.spacer }),
            h('button', {
              type: 'button',
              style: state.probe?.phase === 'running'
                ? { ...styles.ghost, opacity: 0.55 }
                : { ...styles.ghost, borderColor: ACCENT, color: ACCENT, opacity: 1 },
              disabled: state.probe?.phase === 'running',
              title: 'Send a 16-token ping and report whether the upstream answers',
              onClick: probeNow,
            }, state.probe?.phase === 'running' ? 'Probing…' : 'Probe')),
          h('div', { style: styles.actions },
            h('input', {
              type: 'text',
              style: { ...styles.input, flex: '1 1 140px' },
              placeholder: 'Ask something small…',
              value: state.prompt,
              'aria-label': 'Test message',
              onChange: event => setState(prev => ({ ...prev, prompt: event.target.value })),
              onKeyDown: event => {
                if (event.key === 'Enter') send()
              },
            }),
            h('button', {
              type: 'button',
              style: state.attempt?.phase === 'running'
                ? { ...styles.send, ...styles.sendDisabled }
                : styles.send,
              disabled: state.attempt?.phase === 'running',
              onClick: send,
            }, state.attempt?.phase === 'running' ? 'Sending…' : 'Send')),
          h('div', { style: styles.modelPick },
            h('span', { style: styles.dim }, 'Model'),
            h('select', {
              style: styles.select,
              value: state.model,
              'aria-label': 'Model used by the test message',
              title: 'Which model the test message goes to',
              onChange: event => {
                const model = event.target.value
                writeString(MODEL_KEY, model)
                setState(prev => ({ ...prev, model }))
              },
            },
            h('option', { value: '' }, 'Auto (first model)'),
            state.models.map(model => h('option', { key: model.id, value: model.id },
              model.name && model.name !== model.id ? `${model.name} — ${model.id}` : model.id)))),
          state.attempt?.phase === 'done'
            ? h('p', { style: styles.answer }, shownAnswer(state.attempt.result))
            : null,
          state.attempt?.phase === 'done'
            ? h('p', { style: { ...styles.dim, ...styles.mono } },
              state.attempt.result.model ?? '',
              ' · first ',
              formatMs(state.attempt.result.first_token_ms),
              ' · total ',
              formatMs(state.attempt.result.total_ms),
              state.attempt.result.usage
                ? ` · ${formatTokens(state.attempt.result.usage.inputTokens)} in / ${formatTokens(state.attempt.result.usage.outputTokens)} out`
                : '')
            : null,
          state.attempt?.phase === 'error'
            ? h('p', { style: styles.empty }, state.attempt.error)
            : null,
          state.probe === null
            ? null
            : state.probe.phase === 'running'
              ? h('p', { style: styles.dim }, 'Pinging the upstream…')
              : state.probe.phase === 'error'
                ? h('p', { style: { ...styles.empty, margin: 0 } }, '\u2717 ', state.probe.error)
                : h('p', { style: { ...styles.dim, margin: 0 } },
                  '\u2713 Connected \u00b7 ',
                  state.probe.result.model ?? 'auto',
                  ' \u00b7 first ',
                  formatMs(state.probe.result.first_token_ms),
                  ' \u00b7 total ',
                  formatMs(state.probe.result.total_ms)),
          h('p', { style: styles.dim }, 'Probe sends a 16-token ping; Send spends a real completion. Nothing leaves this panel until you click.')),

        // ------------------------------------------------------- quick actions
        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: styles.ghost,
            title: baseURL ?? 'No upstream yet',
            onClick: () => copy(baseURL ?? '', 'base URL'),
          }, 'Copy base URL'),
          h('button', {
            type: 'button',
            style: styles.ghost,
            onClick: () => copy(
              `curl -N ${GATEWAY}/v1/chat/completions \\\n  -H 'content-type: application/json' \\\n  -d '{"model":"<id>","messages":[{"role":"user","content":"hi"}],"stream":true}'`,
              'curl example'),
          }, 'Copy curl'),
          state.copied === null ? null : h('span', { style: styles.dim }, `copied ${state.copied}`)),

        // ------------------------------------------------------- models drawer
        h('div', { style: { ...styles.card, gap: '6px' } },
          h('button', {
            type: 'button',
            style: styles.drawerHead,
            'aria-expanded': state.showModels,
            onClick: () => setState(prev => ({ ...prev, showModels: !prev.showModels })),
          },
          h('span', { style: styles.caret }, state.showModels ? '▾' : '▸'),
          h('p', { style: styles.label }, `Models (${state.models.length})`),
          h('span', { style: styles.spacer }),
          online === true ? h('span', { style: styles.dim }, `read ${state.readAt === null ? '—' : state.readAt.toLocaleTimeString()}`) : null),

          state.showModels
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('input', {
                type: 'search',
                style: styles.search,
                placeholder: 'Filter by id, name or modality',
                value: state.query,
                'aria-label': 'Filter models',
                onChange: event => setState(prev => ({ ...prev, query: event.target.value })),
              }),
              state.models.length === 0
                ? h('p', { style: styles.empty }, online === false
                  ? 'DuMate is not running. Start it with the button at the top, or open the desktop app; this panel follows within 15 seconds.'
                  : 'The upstream is online but reports no models.')
                : null,
              ordered.length === 0 && state.models.length > 0
                ? h('p', { style: styles.empty }, `No model matches “${state.query}”.`)
                : null,
              h('ul', { style: styles.list }, ordered.map(model => {
                const modality = Array.isArray(model.input_modalities) && model.input_modalities.includes('image')
                  ? 'text + image'
                  : 'text'
                const isStarred = state.favorites.includes(model.id)
                return h('li', { key: model.id, style: { display: 'flex', alignItems: 'center', gap: '3px' } },
                  h('button', {
                    type: 'button',
                    style: styles.star,
                    title: isStarred ? 'Remove from favorites' : 'Add to favorites',
                    'aria-label': isStarred ? `Unstar ${model.id}` : `Star ${model.id}`,
                    onClick: () => star(model.id),
                  }, isStarred ? '★' : '☆'),
                  h('button', {
                    type: 'button',
                    style: styles.modelRow,
                    title: `${model.id}\ncontext ${formatWindow(model.context_window)} · ${modality}\nclick to copy the id`,
                    onClick: () => copy(model.id, model.id),
                  },
                  h('span', { style: styles.modelName }, model.id),
                  h('span', { style: styles.dim }, `${formatWindow(model.context_window)} · ${modality}`)))
              })))
            : null),

        // ---------------------------------------------------- diagnostics drawer
        h('div', { style: { ...styles.card, gap: '6px' } },
          h('button', {
            type: 'button',
            style: styles.drawerHead,
            'aria-expanded': state.showDetails,
            onClick: () => setState(prev => ({ ...prev, showDetails: !prev.showDetails })),
          },
          h('span', { style: styles.caret }, state.showDetails ? '▾' : '▸'),
          h('p', { style: styles.label }, 'Details')),

          state.showDetails
            ? h('div', { style: styles.detailsRow },
              h('span', { style: styles.detailsKey }, 'upstream'),
              h('span', { ...styles.detailsValue, style: { ...styles.detailsValue, ...styles.mono } }, baseURL ?? '—'),
              h('span', { style: styles.detailsKey }, 'gateway'),
              h('span', { style: { ...styles.detailsValue, ...styles.mono } }, `${GATEWAY} · v${health?.gateway?.version ?? '?'}`),
              h('span', { style: styles.detailsKey }, 'models'),
              h('span', { style: styles.detailsValue }, `${total} · mode ${modelsMode ?? '?'}`),
              h('span', { style: styles.detailsKey }, 'headless'),
              h('span', { style: styles.detailsValue },
                headlessState === null
                  ? 'off'
                  : `${headlessState.running ? 'running' : 'stopped'} · ports ${headlessState.baseProxyPort}/${headlessState.mainServerPort}`),
              h('span', { style: styles.detailsKey }, 'state file'),
              h('span', { style: { ...styles.detailsValue, ...styles.mono }, title: configPath ?? '' }, configPath ?? '—'),
              reason === null ? null : h('span', { style: styles.detailsKey }, 'reason'),
              reason === null ? null : h('span', { style: styles.detailsValue }, reason),
              h('span', { style: styles.detailsKey }, 'today'),
              h('span', { style: styles.detailsValue },
                usage === null
                  ? '—'
                  : `${usage.requests} req · ${formatTokens(usage.input_tokens)} in / ${formatTokens(usage.output_tokens)} out · ${usage.errors} err`))
            : null))
    }

    return {
      // Service keys, not package ids: package.json's dsh.client.inject lists the
      // client packages this module needs loaded first.
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          priority: 'extension',
          keepMounted: true,
          title: () => 'DuMate',
          guide: [{
            id: 'status',
            order: 60,
            // The guide renders `entry.title()` and `entry.description?.()`: both
            // must be functions, not strings, or the whole guide body throws.
            title: () => 'DuMate gateway',
            description: () => 'Upstream status and the models it offers',
          }],
        }), 'dumate-gateway: sidebar tab type')

        // The registration test renders the offline card in each of its shapes;
        // exposing it keeps that test honest without a live gateway.
        Panel.HeadlessCard = HeadlessCard

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
        }, Panel)), 'dumate-gateway: sidebar panel')
      },
    }
  },
})
