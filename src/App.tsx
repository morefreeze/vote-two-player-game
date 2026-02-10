import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AlertCircle, Gamepad2, LineChart as LineChartIcon, Link2, Timer, Users, Copy } from 'lucide-react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'

type Role = 'red' | 'blue'

const formatRoleLabel = (role: Role) => (role === 'red' ? '红方 Red' : '蓝方 Blue')

type ConnectionMode = 'offer' | 'answer'
type ConnectionStatus = 'idle' | 'creating-offer' | 'waiting-answer' | 'connected' | 'error'
type GameState = 'idle' | 'running' | 'ended'

type VoteEvent = {
  target: Role
  elapsed: number
}

type SnapshotEvent = {
  at: number
  target: Role
}

type GameSnapshot = {
  version: number
  lastUpdatedAt: number
  gameId: string
  sessionId: string | null
  isHost: boolean
  lockedRole: Role
  startTimeSec: number
  endTimeSec: number
  gameState: GameState
  scoreRed: number
  scoreBlue: number
  events: SnapshotEvent[]
}

type HistoryIndexEntry = {
  gameId: string
  startTimeSec: number
  endTimeSec: number
  scoreRed: number
  scoreBlue: number
  lastUpdatedAt: number
}

type SessionRoles = {
  hostRole: Role
  guestRole: Role
}

type Message =
  | { type: 'start'; roundId: string; endTime: number; roles?: SessionRoles }
  | { type: 'vote'; roundId: string; target: Role; at: number }
  | { type: 'proposeEndChange'; roundId: string; proposedEndTime: number }
  | { type: 'acceptEndChange'; roundId: string; proposedEndTime: number }
  | { type: 'rejectEndChange'; roundId: string; proposedEndTime: number }
  | { type: 'proposeEndNow'; roundId: string }
  | { type: 'acceptEndNow'; roundId: string }
  | { type: 'rejectEndNow'; roundId: string }
  | { type: 'assignRoles'; sessionId: string; hostRole: Role; guestRole: Role }
  | { type: 'assignRolesAck'; sessionId: string; myRole: Role }
  | { type: 'stateSnapshot'; roundId: string; payload: GameSnapshot }

const GAME_ID_STORAGE_KEY = 'currentGameId'
const SNAPSHOT_LAST_ID_KEY = 'vote2p:lastSnapshotId'
const SNAPSHOT_KEY_PREFIX = 'vote2p:snapshot:'
const HISTORY_INDEX_KEY = 'vote2p:historyIndex'

const getSnapshotStorageKey = (gameId: string) => `${SNAPSHOT_KEY_PREFIX}${gameId}`

const generateGameId = () => {
  const bytes = new Uint8Array(24)
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 = btoa(binary)
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `GID-${base64url}`
}

const generateSessionId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`


const formatAsDatetimeLocal = (date: Date) => {
  const pad = (value: number) => value.toString().padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

const parseDatetimeLocalToUnixSeconds = (value: string): number | null => {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return null
  return Math.floor(timestamp / 1000)
}

const formatUnixSecondsToLocal = (value: number | null): string => {
  if (!value) return '--'
  const date = new Date(value * 1000)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const iceServers: RTCIceServer[] = [
  {
    urls: 'stun:stun.l.google.com:19302',
  },
]

function App() {
  const [lockedRole, setLockedRole] = useState<Role | null>(null)
  const [roleLocked, setRoleLocked] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [roleSyncMessage, setRoleSyncMessage] = useState<string | null>(null)
  const [connectionMode, setConnectionMode] = useState<ConnectionMode>('offer')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [localSdp, setLocalSdp] = useState('')
  const [remoteSdp, setRemoteSdp] = useState('')

  const [gameState, setGameState] = useState<GameState>('idle')
  const [currentRoundId, setCurrentRoundId] = useState<string | null>(null)
  const [currentGameId, setCurrentGameId] = useState<string | null>(null)
  const [storedGameIdHint, setStoredGameIdHint] = useState<string | null>(null)
  const [gameIdCopyMessage, setGameIdCopyMessage] = useState<string | null>(null)
  const [offlineSnapshotMode, setOfflineSnapshotMode] = useState(false)
  const [snapshotMeta, setSnapshotMeta] = useState<{ version: number; lastUpdatedAt: number } | null>(
    null,
  )
  const [historyIndex, setHistoryIndex] = useState<HistoryIndexEntry[]>([])
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyViewSnapshot, setHistoryViewSnapshot] = useState<GameSnapshot | null>(null)
  const [openHistoryTabs, setOpenHistoryTabs] = useState<Array<{ gameId: string; title: string }>>([])
  const [activeTabKey, setActiveTabKey] = useState<string>('current')
  const [historyViewSnapshots, setHistoryViewSnapshots] = useState<Record<string, GameSnapshot>>({})
  const [startTimeSec, setStartTimeSec] = useState<number | null>(null)
  const [endTimeSec, setEndTimeSec] = useState<number | null>(null)
  const [resolvedEndTimeSec, setResolvedEndTimeSec] = useState<number | null>(null)
  const [timeRemaining, setTimeRemaining] = useState(0)

  const [initialEndTimeInput, setInitialEndTimeInput] = useState<string>(() => {
    const now = new Date()
    now.setMinutes(now.getMinutes() + 10)
    now.setSeconds(0, 0)
    return formatAsDatetimeLocal(now)
  })
  const [proposedEndTimeInput, setProposedEndTimeInput] = useState<string>('')

  const [scores, setScores] = useState<{ red: number; blue: number }>({ red: 0, blue: 0 })
  const [voteEvents, setVoteEvents] = useState<VoteEvent[]>([])

  const [incomingEndChange, setIncomingEndChange] = useState<{ proposedEndTime: number } | null>(null)
  const [incomingEndNow, setIncomingEndNow] = useState(false)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [rolesConfirmed, setRolesConfirmed] = useState(false)
  const [sessionRoles, setSessionRoles] = useState<SessionRoles | null>(null)
  const [voteIgnoreMessage, setVoteIgnoreMessage] = useState<string | null>(null)
  const [roleAssignmentNotice, setRoleAssignmentNotice] = useState<string | null>(null)
  const [newGameConfirmOpen, setNewGameConfirmOpen] = useState(false)

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dataChannelRef = useRef<RTCDataChannel | null>(null)
  const timerRef = useRef<number | null>(null)
  const currentRoundIdRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const lockedRoleRef = useRef<Role | null>(null)
  const connectionModeRef = useRef<ConnectionMode>('offer')
  const hasSentAssignRolesRef = useRef(false)
  const snapshotVersionRef = useRef<number>(0)
  const hasSentStateSnapshotRef = useRef(false)
  const assignRolesRetryCountRef = useRef(0)
  const assignRolesRetryTimerRef = useRef<number | null>(null)
  const rolesConfirmedRef = useRef(false)
  const sessionRolesRef = useRef<SessionRoles | null>(null)

  const resetGameState = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    setCurrentRoundId(null)
    currentRoundIdRef.current = null
    setCurrentGameId(null)
    setStoredGameIdHint(null)
    snapshotVersionRef.current = 0
    setSnapshotMeta(null)
    setOfflineSnapshotMode(false)
    try {
      window.localStorage.removeItem(GAME_ID_STORAGE_KEY)
    } catch (e) {
      console.error(e)
    }
    setStartTimeSec(null)
    setEndTimeSec(null)
    setResolvedEndTimeSec(null)
    setScores({ red: 0, blue: 0 })
    setVoteEvents([])
    setTimeRemaining(0)
    setGameState('idle')
    setIncomingEndChange(null)
    setIncomingEndNow(false)
    setInfoMessage(null)
    setVoteIgnoreMessage(null)
  }, [])

  const applyVote = useCallback(
    (target: Role, elapsed: number) => {
      setScores((prev) => ({ ...prev, [target]: prev[target] + 1 }))
      setVoteEvents((prev) => [...prev, { target, elapsed }])
      setVoteIgnoreMessage(null)
    },
    [],
  )

  const beginGameWithEndTime = useCallback(
    (roundId: string, startSec: number, endSec: number) => {
      if (!Number.isFinite(endSec) || endSec <= startSec) {
        return
      }
      setCurrentRoundId(roundId)
      currentRoundIdRef.current = roundId
      setStartTimeSec(startSec)
      setEndTimeSec(endSec)
      setResolvedEndTimeSec(endSec)
      setScores({ red: 0, blue: 0 })
      setVoteEvents([])
      setTimeRemaining(Math.max(0, endSec - startSec))
      setGameState('running')
      setIncomingEndChange(null)
      setIncomingEndNow(false)
      setInfoMessage(null)
    },
    [],
  )

  const applyEndTimeUpdate = useCallback((newEndTimeSec: number) => {
    setEndTimeSec(newEndTimeSec)
    setResolvedEndTimeSec(newEndTimeSec)
  }, [])

  const applyImmediateEndLocal = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    const nowSec = Math.floor(Date.now() / 1000)
    setEndTimeSec(nowSec)
    setResolvedEndTimeSec(nowSec)
    setTimeRemaining(0)
    setGameState('ended')
    setIncomingEndNow(false)
  }, [])

  const clearAssignRolesRetryTimer = useCallback(() => {
    if (assignRolesRetryTimerRef.current !== null) {
      window.clearTimeout(assignRolesRetryTimerRef.current)
      assignRolesRetryTimerRef.current = null
    }
  }, [])

  const resetSessionAndRolesForNewAnswerJoin = useCallback(() => {
    setRoleLocked(false)
    setLockedRole(null)
    setRoleSyncMessage('等待发起方分配阵营…')
    setSessionRoles(null)
    sessionRolesRef.current = null
    setRolesConfirmed(false)
    rolesConfirmedRef.current = false
    clearAssignRolesRetryTimer()
    assignRolesRetryCountRef.current = 0
  }, [clearAssignRolesRetryTimer])

  const ensureRoleFromSessionRoles = useCallback(
    (reason: 'fallback-start' | 'vote-mismatch') => {
      const roles = sessionRolesRef.current
      if (!roles) return
      const mode = connectionModeRef.current
      const expectedRole: Role = mode === 'offer' ? roles.hostRole : roles.guestRole
      setRoleLocked(true)
      setLockedRole((prev) => {
        if (!prev || prev !== expectedRole) {
          const message =
            reason === 'vote-mismatch'
              ? '角色未正确分配，已自动校正，请重试。'
              : '角色信息已根据对局数据自动校正。'
          setRoleSyncMessage(message)
          return expectedRole
        }
        return prev
      })
    },
    [setLockedRole, setRoleLocked, setRoleSyncMessage],
  )

  const sendAssignRolesOnce = useCallback(() => {
    const channel = dataChannelRef.current
    if (!channel || channel.readyState !== 'open') {
      return false
    }
    const currentLockedRole = lockedRoleRef.current || lockedRole
    if (!currentLockedRole) {
      return false
    }
    const existingSessionId = sessionIdRef.current
    const session = existingSessionId ?? generateSessionId()
    const hostRole = currentLockedRole
    const guestRole: Role = hostRole === 'red' ? 'blue' : 'red'

    setSessionId(session)
    sessionIdRef.current = session
    const sessionRolesValue: SessionRoles = { hostRole, guestRole }
    setSessionRoles(sessionRolesValue)
    sessionRolesRef.current = sessionRolesValue

    try {
      channel.send(
        JSON.stringify({
          type: 'assignRoles',
          sessionId: session,
          hostRole,
          guestRole,
        }),
      )
      hasSentAssignRolesRef.current = true
      setRoleLocked(true)
      setLockedRole(hostRole)
      setRoleSyncMessage(`角色已锁定：${formatRoleLabel(hostRole)}。`)
      return true
    } catch (e) {
      console.error(e)
      setError('发送角色分配信息失败，请尝试重新建立连接。')
      return false
    }
  }, [lockedRole, setError, setLockedRole, setRoleLocked, setRoleSyncMessage, setSessionId, setSessionRoles])

  const sendMessage = useCallback(
    (msg: Message) => {
      const channel = dataChannelRef.current
      if (!channel || channel.readyState !== 'open') {
        setError('数据通道未就绪，无法发送消息，请先完成连接。')
        return
      }
      try {
        channel.send(JSON.stringify(msg))
      } catch (e) {
        console.error(e)
        setError('发送消息失败，请尝试重新建立连接。')
      }
    },
    [setError],
  )

  const buildSnapshotFromState = useCallback((): GameSnapshot | null => {
    if (!currentRoundId || !startTimeSec || !endTimeSec || !lockedRole) {
      return null
    }
    if (gameState === 'idle') {
      return null
    }
    const isHost = connectionModeRef.current === 'offer'
    const now = Date.now()

    return {
      version: snapshotVersionRef.current || 0,
      lastUpdatedAt: now,
      gameId: currentRoundId,
      sessionId,
      isHost,
      lockedRole,
      startTimeSec,
      endTimeSec,
      gameState,
      scoreRed: scores.red,
      scoreBlue: scores.blue,
      events: voteEvents.map((event) => ({ at: event.elapsed, target: event.target })),
    }
  }, [currentRoundId, endTimeSec, gameState, lockedRole, scores, startTimeSec, sessionId, voteEvents])

  const persistSnapshot = useCallback((): GameSnapshot | null => {
    const base = buildSnapshotFromState()
    if (!base) {
      return null
    }
    const newVersion = (snapshotVersionRef.current || 0) + 1
    const snapshot: GameSnapshot = {
      ...base,
      version: newVersion,
      lastUpdatedAt: Date.now(),
    }
    try {
      const storageKey = getSnapshotStorageKey(snapshot.gameId)
      window.localStorage.setItem(storageKey, JSON.stringify(snapshot))
      window.localStorage.setItem(SNAPSHOT_LAST_ID_KEY, snapshot.gameId)
      snapshotVersionRef.current = newVersion
      setSnapshotMeta({ version: newVersion, lastUpdatedAt: snapshot.lastUpdatedAt })
    } catch (e) {
      console.error(e)
    }
    return snapshot
  }, [buildSnapshotFromState])

  const upsertHistoryIndex = useCallback((snapshot: GameSnapshot) => {
    if (!snapshot || snapshot.gameState !== 'ended') return
    const entry: HistoryIndexEntry = {
      gameId: snapshot.gameId,
      startTimeSec: snapshot.startTimeSec,
      endTimeSec: snapshot.endTimeSec,
      scoreRed: snapshot.scoreRed,
      scoreBlue: snapshot.scoreBlue,
      lastUpdatedAt: snapshot.lastUpdatedAt,
    }
    setHistoryIndex((prev) => {
      const next = [...prev]
      const existingIndex = next.findIndex((item) => item.gameId === entry.gameId)
      if (existingIndex >= 0) {
        next[existingIndex] = entry
      } else {
        next.push(entry)
      }
      next.sort((a, b) => {
        if (a.endTimeSec !== b.endTimeSec) {
          return b.endTimeSec - a.endTimeSec
        }
        return b.lastUpdatedAt - a.lastUpdatedAt
      })
      try {
        window.localStorage.setItem(HISTORY_INDEX_KEY, JSON.stringify(next))
      } catch (e) {
        console.error(e)
      }
      return next
    })
  }, [])

  const hydrateStateFromSnapshot = useCallback(
    (snapshot: GameSnapshot, options?: { offline?: boolean; fromRemote?: boolean }) => {
      const nowSec = Math.floor(Date.now() / 1000)
      const remaining =
        snapshot.gameState === 'running' ? Math.max(0, snapshot.endTimeSec - nowSec) : 0

      setCurrentRoundId(snapshot.gameId)
      currentRoundIdRef.current = snapshot.gameId
      setCurrentGameId(snapshot.gameId)
      setStartTimeSec(snapshot.startTimeSec)
      setEndTimeSec(snapshot.endTimeSec)
      setResolvedEndTimeSec(snapshot.endTimeSec)
      setScores({ red: snapshot.scoreRed, blue: snapshot.scoreBlue })
      setVoteEvents(snapshot.events.map((event) => ({ target: event.target, elapsed: event.at })))
      setTimeRemaining(remaining)
      setGameState(snapshot.gameState)
      setLockedRole(snapshot.lockedRole)
      setRoleLocked(true)
      setSessionId(snapshot.sessionId)
      sessionIdRef.current = snapshot.sessionId

      snapshotVersionRef.current = snapshot.version || 0
      setSnapshotMeta({
        version: snapshot.version || 0,
        lastUpdatedAt: snapshot.lastUpdatedAt || Date.now(),
      })

      try {
        const storageKey = getSnapshotStorageKey(snapshot.gameId)
        window.localStorage.setItem(storageKey, JSON.stringify(snapshot))
        window.localStorage.setItem(SNAPSHOT_LAST_ID_KEY, snapshot.gameId)
      } catch (e) {
        console.error(e)
      }

      if (options?.offline) {
        setOfflineSnapshotMode(true)
      }
      setStoredGameIdHint(snapshot.gameId)
      setHistoryViewSnapshot(null)
    },
    [
      setCurrentRoundId,
      setCurrentGameId,
      setStartTimeSec,
      setEndTimeSec,
      setResolvedEndTimeSec,
      setScores,
      setVoteEvents,
      setTimeRemaining,
      setGameState,
      setLockedRole,
      setRoleLocked,
      setSessionId,
      setSnapshotMeta,
      setOfflineSnapshotMode,
      setStoredGameIdHint,
      setHistoryViewSnapshot,
    ],
  )

  const handleIncomingMessage = useCallback(
    (msg: Message) => {
      switch (msg.type) {
        case 'start': {
          const nowSec = Math.floor(Date.now() / 1000)
          if (!Number.isFinite(msg.endTime) || msg.endTime <= nowSec) {
            return
          }

          if (msg.roles) {
            setSessionRoles(msg.roles)
            sessionRolesRef.current = msg.roles
            ensureRoleFromSessionRoles('fallback-start')
          }

          snapshotVersionRef.current = 0
          setSnapshotMeta(null)
          setOfflineSnapshotMode(false)
          setCurrentGameId(msg.roundId)
          setStoredGameIdHint(msg.roundId)
          try {
            window.localStorage.setItem(GAME_ID_STORAGE_KEY, msg.roundId)
          } catch (e) {
            console.error(e)
          }
          try {
            const url = new URL(window.location.href)
            url.searchParams.set('gid', msg.roundId)
            window.history.replaceState(null, '', url.toString())
          } catch (e) {
            console.error(e)
          }
          beginGameWithEndTime(msg.roundId, nowSec, msg.endTime)
          break
        }
        case 'stateSnapshot': {
          const snapshot = msg.payload
          if (!snapshot || !snapshot.gameId) {
            return
          }
          if (currentRoundIdRef.current && currentRoundIdRef.current !== snapshot.gameId) {
            console.warn('收到来自其他局的 stateSnapshot，已忽略。', {
              current: currentRoundIdRef.current,
              incoming: snapshot.gameId,
            })
            return
          }
          hydrateStateFromSnapshot(snapshot, { fromRemote: true })
          setOfflineSnapshotMode(false)
          break
        }
        case 'vote': {
          if (!currentRoundIdRef.current || msg.roundId !== currentRoundIdRef.current) return
          const localLockedRole = lockedRoleRef.current
          if (!localLockedRole) {
            return
          }
          if (msg.target !== localLockedRole) {
            console.warn('投票被忽略：目标阵营不匹配', {
              expected: localLockedRole,
              received: msg.target,
            })
            setVoteIgnoreMessage('角色未正确分配，已自动校正，请重试。')
            ensureRoleFromSessionRoles('vote-mismatch')
            return
          }
          applyVote(msg.target, msg.at)
          break
        }
        case 'assignRoles': {
          const mode = connectionModeRef.current
          const myRole: Role = mode === 'offer' ? msg.hostRole : msg.guestRole
          const newSessionId = msg.sessionId

          setSessionId(newSessionId)
          sessionIdRef.current = newSessionId
          const sessionRolesValue: SessionRoles = { hostRole: msg.hostRole, guestRole: msg.guestRole }
          setSessionRoles(sessionRolesValue)
          sessionRolesRef.current = sessionRolesValue
          setRoleLocked(true)
          setLockedRole((prev) => {
            if (prev && prev !== myRole) {
              setRoleSyncMessage(
                `你本地选择的是${formatRoleLabel(prev)}，已根据发起方方案调整为${formatRoleLabel(
                  myRole,
                )}。`,
              )
            } else {
              setRoleSyncMessage(`角色已锁定：${formatRoleLabel(myRole)}。`)
            }
            return myRole
          })

          if (mode === 'answer') {
            sendMessage({
              type: 'assignRolesAck',
              sessionId: msg.sessionId,
              myRole,
            })
            setRoleAssignmentNotice('角色分配完成，你的阵营已锁定。')
          }

          break
        }
        case 'assignRolesAck': {
          const currentSession = sessionIdRef.current
          if (!currentSession || msg.sessionId !== currentSession) {
            return
          }
          rolesConfirmedRef.current = true
          setRolesConfirmed(true)
          clearAssignRolesRetryTimer()
          setRoleAssignmentNotice('角色分配完成，双方阵营已同步。')
          break
        }
        case 'proposeEndChange': {
          if (!currentRoundIdRef.current || msg.roundId !== currentRoundIdRef.current) return
          setIncomingEndChange({ proposedEndTime: msg.proposedEndTime })
          break
        }
        case 'acceptEndChange': {
          if (!currentRoundIdRef.current || msg.roundId !== currentRoundIdRef.current) return
          applyEndTimeUpdate(msg.proposedEndTime)
          setInfoMessage('对方已同意修改结束时间，已同步更新。')
          break
        }
        case 'rejectEndChange': {
          if (!currentRoundIdRef.current || msg.roundId !== currentRoundIdRef.current) return
          setInfoMessage('对方拒绝了本次结束时间修改，本局保持原结束时间。')
          break
        }
        case 'proposeEndNow': {
          if (!currentRoundIdRef.current || msg.roundId !== currentRoundIdRef.current) return
          setIncomingEndNow(true)
          break
        }
        case 'acceptEndNow': {
          if (!currentRoundIdRef.current || msg.roundId !== currentRoundIdRef.current) return
          applyImmediateEndLocal()
          setInfoMessage('对方已同意立即结束，本局已结束。')
          break
        }
        case 'rejectEndNow': {
          if (!currentRoundIdRef.current || msg.roundId !== currentRoundIdRef.current) return
          setInfoMessage('对方拒绝立即结束，本局继续进行。')
          break
        }
        default:
          break
      }
    },
    [
      applyEndTimeUpdate,
      applyImmediateEndLocal,
      applyVote,
      beginGameWithEndTime,
      clearAssignRolesRetryTimer,
      ensureRoleFromSessionRoles,
      hydrateStateFromSnapshot,
      sendMessage,
    ],
  )

  const setupDataChannel = useCallback(
    (channel: RTCDataChannel) => {
      channel.onopen = () => {
        setConnectionStatus('connected')
        setStatusMessage('已建立 P2P 连接，可以开始对局。')
        setError(null)
      }

      channel.onclose = () => {
        setStatusMessage('数据通道已关闭，可以重新建立连接。')
      }

      channel.onerror = () => {
        setConnectionStatus('error')
        setError('DataChannel 发生错误，请尝试刷新页面或重新建立连接。')
      }

      channel.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as Message
          handleIncomingMessage(parsed)
        } catch (e) {
          console.error('Invalid message from data channel', e)
        }
      }
    },
    [handleIncomingMessage],
  )

  const cleanupConnection = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close()
      } catch (e) {
        console.error(e)
      }
      dataChannelRef.current = null
    }
    if (pcRef.current) {
      try {
        pcRef.current.close()
      } catch (e) {
        console.error(e)
      }
      pcRef.current = null
    }
    setConnectionStatus('idle')
    setStatusMessage('')
    resetGameState()
    setSessionId(null)
    sessionIdRef.current = null
    hasSentAssignRolesRef.current = false
    hasSentStateSnapshotRef.current = false
    clearAssignRolesRetryTimer()
    assignRolesRetryCountRef.current = 0
    setRolesConfirmed(false)
    rolesConfirmedRef.current = false
    setSessionRoles(null)
    sessionRolesRef.current = null
    setLockedRole(null)
    setRoleLocked(false)
    setRoleSyncMessage(null)
    setRoleAssignmentNotice(null)
    setHistoryViewSnapshot(null)
  }, [clearAssignRolesRetryTimer, resetGameState])

  useEffect(() => {
    return () => {
      cleanupConnection()
    }
  }, [cleanupConnection])

  useEffect(() => {
    connectionModeRef.current = connectionMode
  }, [connectionMode])

  useEffect(() => {
    lockedRoleRef.current = lockedRole
  }, [lockedRole])

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    rolesConfirmedRef.current = rolesConfirmed
  }, [rolesConfirmed])

  useEffect(() => {
    sessionRolesRef.current = sessionRoles
  }, [sessionRoles])

  useEffect(() => {
    if (!roleAssignmentNotice) {
      return
    }
    const timer = window.setTimeout(() => {
      setRoleAssignmentNotice(null)
    }, 2500)
    return () => {
      window.clearTimeout(timer)
    }
  }, [roleAssignmentNotice])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(HISTORY_INDEX_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as HistoryIndexEntry[]
      if (!Array.isArray(parsed)) return
      const normalized = parsed
        .filter((item) => item && typeof item.gameId === 'string')
        .map((item) => ({
          gameId: item.gameId,
          startTimeSec: item.startTimeSec,
          endTimeSec: item.endTimeSec,
          scoreRed: item.scoreRed,
          scoreBlue: item.scoreBlue,
          lastUpdatedAt: item.lastUpdatedAt,
        }))
      normalized.sort((a, b) => {
        if (a.endTimeSec !== b.endTimeSec) {
          return b.endTimeSec - a.endTimeSec
        }
        return b.lastUpdatedAt - a.lastUpdatedAt
      })
      setHistoryIndex(normalized)
    } catch (e) {
      console.error(e)
      setHistoryError('读取历史对局列表失败，本地存储可能已被清理。')
    }
  }, [])

  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      const gidFromUrl = url.searchParams.get('gid')
      const lastSnapshotId = window.localStorage.getItem(SNAPSHOT_LAST_ID_KEY)
      const gameIdToUse = gidFromUrl || lastSnapshotId
      if (!gameIdToUse) {
        return
      }
      const raw = window.localStorage.getItem(getSnapshotStorageKey(gameIdToUse))
      if (!raw) {
        return
      }
      const parsed = JSON.parse(raw) as GameSnapshot
      if (!parsed.gameId) {
        return
      }
      const nowSec = Math.floor(Date.now() / 1000)
      if (parsed.gameState === 'ended' && parsed.endTimeSec && nowSec > parsed.endTimeSec) {
        return
      }
      hydrateStateFromSnapshot(parsed, { offline: true })
    } catch (e) {
      console.error(e)
    }
  }, [hydrateStateFromSnapshot])

  useEffect(() => {
    if (!endTimeSec || gameState !== 'running') {
      return
    }

    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }

    const updateRemaining = () => {
      const nowSec = Math.floor(Date.now() / 1000)
      const remaining = endTimeSec - nowSec
      if (remaining <= 0) {
        setTimeRemaining(0)
        setGameState('ended')
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current)
          timerRef.current = null
        }
      } else {
        setTimeRemaining(remaining)
      }
    }

    updateRemaining()
    timerRef.current = window.setInterval(updateRemaining, 1000)

    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [endTimeSec, gameState])

  useEffect(() => {
    if (!currentRoundId || !startTimeSec || !endTimeSec || !lockedRole) {
      return
    }
    if (gameState === 'idle') {
      return
    }
    const snapshot = persistSnapshot()
    if (snapshot && snapshot.gameState === 'ended') {
      upsertHistoryIndex(snapshot)
    }
  }, [currentRoundId, endTimeSec, gameState, lockedRole, persistSnapshot, startTimeSec, upsertHistoryIndex])

  useEffect(() => {
    if (gameState !== 'ended') {
      return
    }
    try {
      window.localStorage.removeItem(GAME_ID_STORAGE_KEY)
    } catch (e) {
      console.error(e)
    }
    setStoredGameIdHint(null)
    try {
      if (currentRoundId && endTimeSec) {
        const nowSec = Math.floor(Date.now() / 1000)
        if (nowSec > endTimeSec) {
          window.localStorage.removeItem(SNAPSHOT_LAST_ID_KEY)
        }
      }
    } catch (e) {
      console.error(e)
    }
  }, [currentRoundId, endTimeSec, gameState])

  useEffect(() => {
    currentRoundIdRef.current = currentRoundId
  }, [currentRoundId])

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      clearAssignRolesRetryTimer()
      assignRolesRetryCountRef.current = 0
      setRolesConfirmed(false)
      rolesConfirmedRef.current = false
      return
    }
    if (connectionModeRef.current !== 'offer') {
      return
    }
    if (!lockedRole) {
      return
    }
    if (assignRolesRetryCountRef.current > 0 && hasSentAssignRolesRef.current) {
      return
    }

    const initialSent = sendAssignRolesOnce()
    if (!initialSent) {
      return
    }

    assignRolesRetryCountRef.current = 1
    rolesConfirmedRef.current = false
    setRolesConfirmed(false)

    const scheduleRetry = () => {
      clearAssignRolesRetryTimer()
      assignRolesRetryTimerRef.current = window.setTimeout(() => {
        if (rolesConfirmedRef.current) {
          return
        }
        if (assignRolesRetryCountRef.current >= 3) {
          return
        }
        const channel = dataChannelRef.current
        if (!channel || channel.readyState !== 'open') {
          return
        }
        const sent = sendAssignRolesOnce()
        if (!sent) {
          return
        }
        assignRolesRetryCountRef.current += 1
        scheduleRetry()
      }, 2000)
    }

    scheduleRetry()
  }, [clearAssignRolesRetryTimer, connectionStatus, lockedRole, sendAssignRolesOnce, setRolesConfirmed])

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      hasSentStateSnapshotRef.current = false
      return
    }
    if (connectionModeRef.current !== 'offer') {
      return
    }
    if (!currentRoundId || !startTimeSec || !endTimeSec || !lockedRole) {
      return
    }
    if (gameState === 'idle') {
      return
    }
    if (hasSentStateSnapshotRef.current) {
      return
    }

    const channel = dataChannelRef.current
    if (!channel || channel.readyState !== 'open') {
      return
    }

    const snapshot = buildSnapshotFromState()
    if (!snapshot) {
      return
    }

    try {
      channel.send(
        JSON.stringify({
          type: 'stateSnapshot',
          roundId: snapshot.gameId,
          payload: snapshot,
        }),
      )
      hasSentStateSnapshotRef.current = true
    } catch (e) {
      console.error(e)
    }
  }, [
    buildSnapshotFromState,
    connectionStatus,
    currentRoundId,
    endTimeSec,
    gameState,
    lockedRole,
    startTimeSec,
  ])

  const createPeerConnection = useCallback(
    (mode: ConnectionMode) => {
      if (pcRef.current) {
        pcRef.current.close()
        pcRef.current = null
      }
      if (dataChannelRef.current) {
        dataChannelRef.current.close()
        dataChannelRef.current = null
      }

      setError(null)
      setLocalSdp('')
      setRemoteSdp('')

      const pc = new RTCPeerConnection({ iceServers })

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState
        if (state === 'failed' || state === 'disconnected') {
          setConnectionStatus('error')
          setError('P2P 连接出现问题，请检查网络或重新建立连接。')
        }
      }

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState
        if (state === 'connected') {
          setConnectionStatus('connected')
          setStatusMessage('已建立 P2P 连接，可以开始对局。')
        } else if (state === 'connecting') {
          setStatusMessage('正在建立连接，请稍候…')
        } else if (state === 'failed' || state === 'disconnected') {
          setConnectionStatus('error')
          setError('连接已中断，请尝试重新建立连接。')
        }
      }

      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          const desc = pc.localDescription
          if (desc) {
            setLocalSdp(JSON.stringify(desc))
          }
        }
      }

      if (mode === 'offer') {
        const channel = pc.createDataChannel('vote-channel')
        dataChannelRef.current = channel
        setupDataChannel(channel)
      } else {
        resetSessionAndRolesForNewAnswerJoin()
        pc.ondatachannel = (event) => {
          const channel = event.channel
          dataChannelRef.current = channel
          setupDataChannel(channel)
        }
      }

      pcRef.current = pc
      return pc
    },
    [resetSessionAndRolesForNewAnswerJoin, setupDataChannel],
  )

  const handleCreateOffer = async () => {
    try {
      setConnectionMode('offer')
      setConnectionStatus('creating-offer')
      setStatusMessage('正在创建 Offer 并收集 ICE 候选…')
      const pc = createPeerConnection('offer')
      if (!pc) return
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
    } catch (e) {
      console.error(e)
      setConnectionStatus('error')
      setError('创建 Offer 失败，请刷新后重试。')
    }
  }

  const handleApplyRemoteAnswer = async () => {
    try {
      const pc = pcRef.current
      if (!pc) {
        setError('请先生成 Offer。')
        return
      }
      if (!remoteSdp.trim()) {
        setError('请先粘贴对方发送的 Answer JSON 文本。')
        return
      }
      const parsed = JSON.parse(remoteSdp)
      await pc.setRemoteDescription(parsed)
      setStatusMessage('已应用对方 Answer，等待连接建立…')
    } catch (e) {
      console.error(e)
      setConnectionStatus('error')
      setError('解析或应用 Answer 失败，请确认完整复制粘贴。')
    }
  }

  const handleApplyOfferAndCreateAnswer = async () => {
    try {
      setConnectionMode('answer')
      resetSessionAndRolesForNewAnswerJoin()
      setStatusMessage('正在应用对方 Offer 并创建 Answer…')
      const pc = createPeerConnection('answer')
      if (!pc) return
      if (!remoteSdp.trim()) {
        setError('请先粘贴对方发送的 Offer JSON 文本。')
        return
      }
      const parsed = JSON.parse(remoteSdp)
      await pc.setRemoteDescription(parsed)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      setConnectionStatus('waiting-answer')
      setStatusMessage('Answer 已生成，复制给对方后等待连接。')
    } catch (e) {
      console.error(e)
      setConnectionStatus('error')
      setError('处理 Offer / 创建 Answer 失败，请确认 JSON 文本是否完整。')
    }
  }

  const handleCopyLocalSdp = async () => {
    if (!localSdp) return
    try {
      await navigator.clipboard.writeText(localSdp)
      setStatusMessage('已复制到系统剪贴板。')
    } catch (e) {
      console.error(e)
      setStatusMessage('复制失败，请手动全选文本后复制。')
    }
  }

  const handleCopyGameId = async () => {
    const idToCopy = historyViewSnapshot?.gameId || currentGameId
    if (!idToCopy) return
    try {
      await navigator.clipboard.writeText(idToCopy)
      setGameIdCopyMessage('已复制本局 Game ID。')
    } catch (e) {
      console.error(e)
      setGameIdCopyMessage('复制失败，请手动选中 Game ID 后复制。')
    }
  }

  const handleDiscardSnapshotFromBanner = () => {
    const gameId = currentRoundId || currentGameId || storedGameIdHint
    try {
      if (gameId) {
        window.localStorage.removeItem(getSnapshotStorageKey(gameId))
        const lastId = window.localStorage.getItem(SNAPSHOT_LAST_ID_KEY)
        if (lastId === gameId) {
          window.localStorage.removeItem(SNAPSHOT_LAST_ID_KEY)
        }
      } else {
        window.localStorage.removeItem(SNAPSHOT_LAST_ID_KEY)
      }
    } catch (e) {
      console.error(e)
    }
    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('gid')
      window.history.replaceState(null, '', url.toString())
    } catch (e) {
      console.error(e)
    }
    resetGameState()
    setHistoryViewSnapshot(null)
    setActiveTabKey('current')
  }

  const handleDiscardSnapshotFromStats = () => {
    const gameId = historyViewSnapshot?.gameId || currentRoundId || currentGameId || storedGameIdHint
    if (!gameId) {
      return
    }
    try {
      window.localStorage.removeItem(getSnapshotStorageKey(gameId))
      const lastId = window.localStorage.getItem(SNAPSHOT_LAST_ID_KEY)
      if (lastId === gameId) {
        window.localStorage.removeItem(SNAPSHOT_LAST_ID_KEY)
      }
    } catch (e) {
      console.error(e)
    }
    setSnapshotMeta(null)
  }

  const handleLoadHistoryGame = (gameId: string) => {
    setHistoryError(null)
    try {
      let snapshot = historyViewSnapshots[gameId]
      if (!snapshot) {
        const raw = window.localStorage.getItem(getSnapshotStorageKey(gameId))
        if (!raw) {
          setHistoryError('找不到该对局的快照，本地记录可能已被清理。')
          return
        }
        const parsed = JSON.parse(raw) as GameSnapshot
        if (!parsed || !parsed.gameId) {
          setHistoryError('快照数据格式异常，无法加载历史对局。')
          return
        }
        snapshot = parsed
        setHistoryViewSnapshots((prev) => ({ ...prev, [gameId]: parsed }))
      }

      setOpenHistoryTabs((prev) => {
        if (prev.some((item) => item.gameId === gameId)) return prev
        const title = gameId.startsWith('GID-') ? `GID-${gameId.slice(4, 11)}` : gameId.slice(0, 10)
        return [...prev, { gameId, title }]
      })

      setActiveTabKey(`hist-${gameId}`)
      setHistoryViewSnapshot(snapshot)
      setOfflineSnapshotMode(false)
      setVoteIgnoreMessage(null)
    } catch (e) {
      console.error(e)
      setHistoryError('加载历史对局失败，请稍后重试。')
    }
  }

  const handleDeleteHistoryGame = (gameId: string) => {
    setHistoryIndex((prev) => {
      const next = prev.filter((item) => item.gameId !== gameId)
      try {
        window.localStorage.setItem(HISTORY_INDEX_KEY, JSON.stringify(next))
        window.localStorage.removeItem(getSnapshotStorageKey(gameId))
      } catch (e) {
        console.error(e)
      }
      return next
    })

    setOpenHistoryTabs((prev) => prev.filter((item) => item.gameId !== gameId))

    if (activeTabKey === `hist-${gameId}`) {
      setActiveTabKey('current')
      setHistoryViewSnapshot(null)
    }
  }

  const handleExitHistoryView = () => {
    setHistoryViewSnapshot(null)
    setHistoryError(null)
    setActiveTabKey('current')
  }

  const handleStartNewRound = () => {
    const prevGameId = currentRoundIdRef.current || currentGameId || null

    resetGameState()

    try {
      const lastId = window.localStorage.getItem(SNAPSHOT_LAST_ID_KEY)
      if (prevGameId) {
        window.localStorage.removeItem(getSnapshotStorageKey(prevGameId))
        if (lastId === prevGameId) {
          window.localStorage.removeItem(SNAPSHOT_LAST_ID_KEY)
        }
      } else {
        if (lastId) {
          window.localStorage.removeItem(getSnapshotStorageKey(lastId))
        }
        window.localStorage.removeItem(SNAPSHOT_LAST_ID_KEY)
      }
    } catch (e) {
      console.error(e)
    }

    try {
      const url = new URL(window.location.href)
      url.searchParams.delete('gid')
      window.history.replaceState(null, '', url.toString())
    } catch (e) {
      console.error(e)
    }

    setSessionId(null)
    sessionIdRef.current = null
    hasSentAssignRolesRef.current = false
    hasSentStateSnapshotRef.current = false
    clearAssignRolesRetryTimer()
    assignRolesRetryCountRef.current = 0
    setRolesConfirmed(false)
    rolesConfirmedRef.current = false
    setSessionRoles(null)
    sessionRolesRef.current = null
    setLockedRole(null)
    setRoleLocked(false)
    setRoleSyncMessage(null)
    setRoleAssignmentNotice(null)
    setHistoryViewSnapshot(null)
    setActiveTabKey('current')
    setInfoMessage(null)
    setVoteIgnoreMessage(null)
    setIncomingEndChange(null)
    setIncomingEndNow(false)
  }

  const handleNewGameClick = () => {
    let hasSnapshotFlag = false
    try {
      const lastId = window.localStorage.getItem(SNAPSHOT_LAST_ID_KEY)
      if (lastId) {
        hasSnapshotFlag = true
      }
    } catch (e) {
      console.error(e)
    }

    if (gameState === 'running' || hasSnapshotFlag) {
      setNewGameConfirmOpen(true)
      return
    }

    handleStartNewRound()
  }

  const handleStartGame = () => {
    if (historyViewSnapshot) {
      setError('当前正在查看历史对局（只读），请先返回当前会话或新开一局。')
      return
    }
    if (!lockedRole) {
      setError('请先在步骤 1 中确认阵营并完成角色锁定。')
      return
    }
    if (connectionStatus !== 'connected') {
      setError('请先完成 P2P 连接，再开始对局。')
      return
    }
    const endTimeUnix = parseDatetimeLocalToUnixSeconds(initialEndTimeInput)
    if (!endTimeUnix) {
      setError('请先选择一个合法的结束时间。')
      return
    }
    const nowSec = Math.floor(Date.now() / 1000)
    if (endTimeUnix <= nowSec) {
      setError('结束时间必须晚于当前时间。')
      return
    }

    const roles = sessionRolesRef.current
    let hostRole: Role
    let guestRole: Role
    if (roles) {
      hostRole = roles.hostRole
      guestRole = roles.guestRole
    } else if (connectionModeRef.current === 'offer') {
      hostRole = lockedRole
      guestRole = lockedRole === 'red' ? 'blue' : 'red'
    } else {
      guestRole = lockedRole
      hostRole = lockedRole === 'red' ? 'blue' : 'red'
    }

    if (!roles) {
      const sessionRolesValue: SessionRoles = { hostRole, guestRole }
      setSessionRoles(sessionRolesValue)
      sessionRolesRef.current = sessionRolesValue
    }

    snapshotVersionRef.current = 0
    setSnapshotMeta(null)
    setOfflineSnapshotMode(false)
    const gameId = generateGameId()
    setCurrentGameId(gameId)
    setStoredGameIdHint(gameId)
    try {
      window.localStorage.setItem(GAME_ID_STORAGE_KEY, gameId)
    } catch (e) {
      console.error(e)
    }
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('gid', gameId)
      window.history.replaceState(null, '', url.toString())
    } catch (e) {
      console.error(e)
    }
    beginGameWithEndTime(gameId, nowSec, endTimeUnix)
    sendMessage({ type: 'start', roundId: gameId, endTime: endTimeUnix, roles: { hostRole, guestRole } })
  }

  const handleProposeEndChange = () => {
    if (historyViewSnapshot) {
      setError('当前为历史只读模式，无法协商修改结束时间。')
      return
    }
    if (connectionStatus !== 'connected') {
      setError('请先完成 P2P 连接，再发起结束时间协商。')
      return
    }
    if (gameState !== 'running' || !currentRoundId) {
      setError('只有在本局进行中时才能协商修改结束时间。')
      return
    }
    const baseInput = proposedEndTimeInput || initialEndTimeInput
    const proposedUnix = parseDatetimeLocalToUnixSeconds(baseInput)
    if (!proposedUnix) {
      setError('请先选择一个合法的新的结束时间。')
      return
    }
    const nowSec = Math.floor(Date.now() / 1000)
    if (proposedUnix <= nowSec) {
      setError('新的结束时间必须晚于当前时间。')
      return
    }
    sendMessage({ type: 'proposeEndChange', roundId: currentRoundId, proposedEndTime: proposedUnix })
    setInfoMessage('已向对方发出修改结束时间的提议，等待对方回应。')
  }

  const handleProposeEndNow = () => {
    if (historyViewSnapshot) {
      setError('当前为历史只读模式，无法提议立即结束。')
      return
    }
    if (connectionStatus !== 'connected') {
      setError('请先完成 P2P 连接，再发起立即结束的提议。')
      return
    }
    if (gameState !== 'running' || !currentRoundId) {
      setError('只有在本局进行中时才能提议立即结束。')
      return
    }
    sendMessage({ type: 'proposeEndNow', roundId: currentRoundId })
    setInfoMessage('已向对方发出“立即结束本局”的提议。')
  }

  const handleAcceptIncomingEndChange = () => {
    if (!incomingEndChange || !currentRoundId) return
    applyEndTimeUpdate(incomingEndChange.proposedEndTime)
    sendMessage({
      type: 'acceptEndChange',
      roundId: currentRoundId,
      proposedEndTime: incomingEndChange.proposedEndTime,
    })
    setIncomingEndChange(null)
    setInfoMessage('你已同意修改结束时间，已同步更新。')
  }

  const handleRejectIncomingEndChange = () => {
    if (!incomingEndChange || !currentRoundId) return
    sendMessage({
      type: 'rejectEndChange',
      roundId: currentRoundId,
      proposedEndTime: incomingEndChange.proposedEndTime,
    })
    setIncomingEndChange(null)
    setInfoMessage('你已拒绝本次结束时间修改，本局保持原结束时间。')
  }

  const handleAcceptIncomingEndNow = () => {
    if (!currentRoundId) return
    applyImmediateEndLocal()
    sendMessage({ type: 'acceptEndNow', roundId: currentRoundId })
    setInfoMessage('你已同意立即结束，本局已结束。')
  }

  const handleRejectIncomingEndNow = () => {
    if (!currentRoundId) return
    setIncomingEndNow(false)
    sendMessage({ type: 'rejectEndNow', roundId: currentRoundId })
    setInfoMessage('你已拒绝立即结束，本局继续进行。')
  }

  const handleSelectRole = (nextRole: Role) => {
    if (roleLocked && lockedRole && lockedRole !== nextRole) {
      setRoleSyncMessage('角色已锁定，如需更换阵营，请断开当前连接并重新进入房间。')
      return
    }
    setLockedRole(nextRole)
    setRoleLocked(true)
    setRoleSyncMessage(`角色已锁定：${formatRoleLabel(nextRole)}。`)
  }

  const handleVote = () => {
    if (historyViewSnapshot) {
      setError('当前正在查看历史对局（只读），无法投票，请先返回当前会话。')
      return
    }
    if (!lockedRole) {
      setError('角色尚未锁定，请先在步骤 1 中选择阵营。')
      return
    }
    if (connectionStatus !== 'connected') {
      setError('连接尚未建立，无法投票。')
      return
    }
    if (gameState !== 'running' || !startTimeSec || !currentRoundId) {
      setError('本局尚未开始或已经结束，无法继续投票。')
      return
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const elapsed = Math.max(0, nowSec - startTimeSec)
    const target: Role = lockedRole === 'red' ? 'blue' : 'red'
    applyVote(target, elapsed)
    sendMessage({ type: 'vote', roundId: currentRoundId, target, at: elapsed })
  }

  const isConnected = connectionStatus === 'connected'

  const liveTotalDurationSec = useMemo(() => {
    if (!startTimeSec || !resolvedEndTimeSec) return null
    return Math.max(0, resolvedEndTimeSec - startTimeSec)
  }, [resolvedEndTimeSec, startTimeSec])

  const gameDuration = liveTotalDurationSec

  const displayResolvedEndTimeSec = resolvedEndTimeSec

  const liveTimeLabel = useMemo(() => {
    if (!endTimeSec || gameState === 'idle') {
      return '--:--'
    }
    const totalSeconds = Math.max(0, timeRemaining)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }, [endTimeSec, gameState, timeRemaining])

  const displayTimeLabel = liveTimeLabel

  const displayScores = scores

  const displayGameId = currentGameId

  const scoreDiff = scores.red - scores.blue

  const resultLabel = useMemo(() => {
    if (!currentRoundId || !startTimeSec) return '等待本局开始'
    if (scoreDiff === 0) return '当前：平局'
    if (scoreDiff > 0) return `当前：红方领先 ${scoreDiff}`
    return `当前：蓝方领先 ${Math.abs(scoreDiff)}`
  }, [currentRoundId, scoreDiff, startTimeSec])

  const chartData = useMemo(() => {
    const baseEvents: VoteEvent[] = voteEvents

    const durationFromTimes = liveTotalDurationSec ?? 0

    const maxElapsedFromVotes =
      baseEvents.length > 0 ? Math.max(...baseEvents.map((event) => event.elapsed)) : 0

    const finalDuration = Math.max(durationFromTimes, maxElapsedFromVotes)
    const idForChart = currentRoundId
    if (!idForChart || finalDuration <= 0) return []

    const points: { second: number; red: number; blue: number }[] = []
    let redAcc = 0
    let blueAcc = 0

    for (let second = 0; second <= finalDuration; second += 1) {
      baseEvents.forEach((event) => {
        if (event.elapsed === second) {
          if (event.target === 'red') {
            redAcc += 1
          } else {
            blueAcc += 1
          }
        }
      })
      points.push({ second, red: redAcc, blue: blueAcc })
    }

    return points
  }, [currentRoundId, liveTotalDurationSec, voteEvents])

  const buildChartDataForSnapshot = (snapshot: GameSnapshot) => {
    const baseEvents: VoteEvent[] = snapshot.events.map((event) => ({
      target: event.target,
      elapsed: event.at,
    }))

    const durationFromTimes = Math.max(0, snapshot.endTimeSec - snapshot.startTimeSec)

    const maxElapsedFromVotes =
      baseEvents.length > 0 ? Math.max(...baseEvents.map((event) => event.elapsed)) : 0

    const finalDuration = Math.max(durationFromTimes, maxElapsedFromVotes)
    if (finalDuration <= 0) return [] as { second: number; red: number; blue: number }[]

    const points: { second: number; red: number; blue: number }[] = []
    let redAcc = 0
    let blueAcc = 0

    for (let second = 0; second <= finalDuration; second += 1) {
      baseEvents.forEach((event) => {
        if (event.elapsed === second) {
          if (event.target === 'red') {
            redAcc += 1
          } else {
            blueAcc += 1
          }
        }
      })
      points.push({ second, red: redAcc, blue: blueAcc })
    }

    return points
  }

  const pendingEndChangeSummary = useMemo(() => {
    if (!incomingEndChange) return null
    const proposed = incomingEndChange.proposedEndTime
    const current = endTimeSec
    const diffSec = current ? proposed - current : 0
    const diffMinutes = Math.round(Math.abs(diffSec) / 60)
    let diffText = '与当前结束时间相同。'
    if (current) {
      if (diffSec > 0) {
        diffText = `比当前结束时间延后约 ${diffMinutes} 分钟。`
      } else if (diffSec < 0) {
        diffText = `比当前结束时间提前约 ${diffMinutes} 分钟。`
      }
    }
    return {
      proposedLabel: formatUnixSecondsToLocal(proposed),
      currentLabel: formatUnixSecondsToLocal(current ?? null),
      diffText,
    }
  }, [endTimeSec, incomingEndChange])

  const gameStateLabel: string = (() => {
    switch (gameState) {
      case 'idle':
        return '未开始'
      case 'running':
        return '进行中'
      case 'ended':
        return '已结束'
      default:
        return ''
    }
  })()

  const connectionStatusLabel: { text: string; tone: 'neutral' | 'warning' | 'success' | 'error' } = (() => {
    switch (connectionStatus) {
      case 'idle':
        return { text: '尚未连接', tone: 'neutral' }
      case 'creating-offer':
      case 'waiting-answer':
        return { text: '信令交换中', tone: 'warning' }
      case 'connected':
        return { text: 'P2P 已连接', tone: 'success' }
      case 'error':
        return { text: '连接异常', tone: 'error' }
      default:
        return { text: '未知状态', tone: 'neutral' }
    }
  })()

  const connectionBadgeClasses = (() => {
    const base = 'px-2.5 py-0.5 text-[11px] font-medium rounded-full border'
    switch (connectionStatusLabel.tone) {
      case 'success':
        return `${base} border-emerald-200 bg-emerald-50 text-emerald-700`
      case 'warning':
        return `${base} border-amber-200 bg-amber-50 text-amber-700`
      case 'error':
        return `${base} border-red-200 bg-red-50 text-red-700`
      default:
        return `${base} border-slate-200 bg-white text-slate-700`
    }
  })()

  const handleChangeConnectionMode = (mode: ConnectionMode) => {
    setConnectionMode(mode)
    setLocalSdp('')
    setRemoteSdp('')
    setError(null)
    setStatusMessage('')
  }

  const handleChangeHistoryTab = (value: string) => {
    setActiveTabKey(value)
    if (value === 'current' || value === 'history-list') {
      setHistoryViewSnapshot(null)
      return
    }
    if (value.startsWith('hist-')) {
      const gameId = value.slice(5)
      const cached = historyViewSnapshots[gameId]
      if (cached) {
        setHistoryViewSnapshot(cached)
        setOfflineSnapshotMode(false)
        setVoteIgnoreMessage(null)
        setHistoryError(null)
        return
      }
      try {
        const raw = window.localStorage.getItem(getSnapshotStorageKey(gameId))
        if (!raw) {
          setHistoryError('找不到该对局的快照，本地记录可能已被清理。')
          return
        }
        const parsed = JSON.parse(raw) as GameSnapshot
        if (!parsed || !parsed.gameId) {
          setHistoryError('快照数据格式异常，无法加载历史对局。')
          return
        }
        setHistoryViewSnapshots((prev) => ({ ...prev, [gameId]: parsed }))
        setHistoryViewSnapshot(parsed)
        setOfflineSnapshotMode(false)
        setVoteIgnoreMessage(null)
        setHistoryError(null)
      } catch (e) {
        console.error(e)
        setHistoryError('加载历史对局失败，请稍后重试。')
      }
    }
  }

  const handleCloseHistoryTab = (gameId: string, event?: { stopPropagation?: () => void }) => {
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation()
    }
    setOpenHistoryTabs((prev) => prev.filter((item) => item.gameId !== gameId))
    if (activeTabKey === `hist-${gameId}`) {
      setActiveTabKey('current')
      setHistoryViewSnapshot(null)
    }
  }

  return (
    <TooltipProvider>
      <div
        className='min-h-screen bg-gradient-to-br from-sky-50 via-slate-50 to-slate-100 text-slate-900'
        style={{
          fontFamily:
            'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <main className='mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 md:px-8 md:py-8'>
          <header className='mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-center md:justify-between'>
            <div>
              <div className='inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-[11px] font-medium shadow-sm ring-1 ring-slate-200'>
                <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
                <span>浏览器直连 · 零后端 · WebRTC DataChannel</span>
              </div>
              <h1 className='mt-3 text-2xl font-bold tracking-tight text-slate-900 md:text-3xl'>
                红蓝对决 · 两人实时投票小游戏
              </h1>
              <p className='mt-2 max-w-2xl text-xs text-slate-600 md:text-sm'>
                两个玩家通过浏览器建立 P2P 连接，只能为对方加分，在限定时间内比拼最终得分和分差，结束后自动生成累计得分曲线。
              </p>
            </div>
            <div className='flex flex-col items-start gap-2 text-[11px] text-slate-600 md:items-end'>
              <div className='flex items-center gap-2'>
                <span className={connectionBadgeClasses}>{connectionStatusLabel.text}</span>
                <span className='inline-flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-slate-50 shadow-md'>
                  <Gamepad2 className='h-3.5 w-3.5' />
                  <span>对局状态：{gameStateLabel}</span>
                </span>
              </div>
              <div className='flex flex-wrap gap-2'>
                <span>
                  你的阵营{roleLocked ? '（已锁定）' : '（未锁定）'}：
                  <span className='font-medium text-slate-900'>
                    {lockedRole === 'red' && '红方 Red'}
                    {lockedRole === 'blue' && '蓝方 Blue'}
                    {!lockedRole && '未锁定'}
                  </span>
                </span>
                <Separator orientation='vertical' className='h-3.5 bg-slate-200' />
                <span>
                  结束时间：
                  <span className='font-medium text-slate-900'>
                    {displayResolvedEndTimeSec
                      ? formatUnixSecondsToLocal(displayResolvedEndTimeSec)
                      : '未设定'}
                  </span>
                </span>
                <Separator orientation='vertical' className='h-3.5 bg-slate-200' />
                <span>
                  剩余时间：
                  <span className='font-medium text-slate-900'>{displayTimeLabel}</span>
                </span>
              </div>
            </div>
          </header>

          <section className='mb-4 grid gap-3 rounded-2xl border border-slate-200/80 bg-white/80 p-3 text-[11px] shadow-sm backdrop-blur md:mb-6 md:grid-cols-5 md:gap-4 md:px-4 md:py-3'>
            <div className='flex items-center gap-2 md:border-r md:border-slate-200 md:pr-4'>
              <Users className='h-4 w-4 text-slate-500' />
              <div>
                <div className='font-medium text-slate-900'>选择阵营</div>
                <div className='text-[11px] text-slate-600'>决定你在比分板上的颜色，只能给“对方”加分。</div>
              </div>
            </div>
            <div className='flex items-center gap-2 md:border-r md:border-slate-200 md:px-4'>
              <Link2 className='h-4 w-4 text-slate-500' />
              <div>
                <div className='font-medium text-slate-900'>建立 P2P 连接</div>
                <div className='text-[11px] text-slate-600'>一人创建 Offer，另一人生成 Answer，通过复制粘贴完成信令。</div>
              </div>
            </div>
            <div className='flex items-center gap-2 md:border-r md:border-slate-200 md:px-4'>
              <Timer className='h-4 w-4 text-slate-500' />
              <div>
                <div className='font-medium text-slate-900'>设置结束时间点</div>
                <div className='text-[11px] text-slate-600'>开局前选择一个具体的结束时间点（默认当前时间后 10 分钟）。</div>
              </div>
            </div>
            <div className='flex items-center gap-2 md:border-r md:border-slate-200 md:px-4'>
              <Gamepad2 className='h-4 w-4 text-slate-500' />
              <div>
                <div className='font-medium text-slate-900'>开始对局</div>
                <div className='text-[11px] text-slate-600'>只允许为对方加分，比分实时同步到对端。</div>
              </div>
            </div>
            <div className='flex items-center gap-2 md:px-4'>
              <LineChartIcon className='h-4 w-4 text-slate-500' />
              <div>
                <div className='font-medium text-slate-900'>截止结算与曲线</div>
                <div className='text-[11px] text-slate-600'>到时自动锁定操作，展示双方总分、分差与累计曲线。</div>
              </div>
            </div>
          </section>

          {error && (
            <Alert
              variant='destructive'
              className='mb-4 border-red-200 bg-red-50 text-red-800 shadow-sm'
            >
              <div className='flex items-start gap-3'>
                <AlertCircle className='mt-0.5 h-4 w-4 flex-shrink-0' />
                <div>
                  <AlertTitle className='text-sm font-semibold'>出现一点问题</AlertTitle>
                  <AlertDescription className='mt-1 text-xs md:text-sm'>{error}</AlertDescription>
                </div>
              </div>
            </Alert>
          )}

          {roleAssignmentNotice && (
            <Alert className='mb-4 border-emerald-200 bg-emerald-50 text-emerald-900 shadow-sm'>
              <div className='flex items-start gap-3'>
                <Users className='mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500' />
                <div>
                  <AlertTitle className='text-sm font-semibold'>角色分配完成</AlertTitle>
                  <AlertDescription className='mt-1 text-xs md:text-sm'>
                    {roleAssignmentNotice}
                  </AlertDescription>
                </div>
              </div>
            </Alert>
          )}

          {activeTabKey.startsWith('hist-') && historyViewSnapshot && (
            <Alert className='mb-4 border-sky-200 bg-sky-50 text-sky-900 shadow-sm'>
              <div className='flex flex-col gap-3 md:flex-row md:items-center md:justify-between'>
                <div>
                  <AlertTitle className='text-sm font-semibold'>正在查看历史对局（只读）</AlertTitle>
                  <AlertDescription className='mt-1 text-[11px] md:text-xs'>
                    <div>
                      当前展示的是历史对局的最终状态与曲线，Game ID：
                      <span className='ml-1 font-mono text-xs md:text-sm'>
                        {historyViewSnapshot.gameId}
                      </span>
                    </div>
                    <div className='mt-1 text-[11px] text-sky-800'>
                      本模式下无法投票或修改结束时间，点击右侧按钮可返回当前会话视图。
                    </div>
                  </AlertDescription>
                </div>
                <div className='flex flex-shrink-0 flex-col items-stretch gap-1 md:items-end'>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='h-8 rounded-full border-sky-300 bg-sky-50 px-3 text-[11px] text-sky-800 hover:bg-sky-100'
                    onClick={handleExitHistoryView}
                  >
                    返回当前会话
                  </Button>
                  <span className='text-[11px] text-sky-700'>
                    若当前仍有进行中的局，返回后可继续操作；否则可在步骤 3 中新开一局。
                  </span>
                </div>
              </div>
            </Alert>
          )}

          {offlineSnapshotMode && storedGameIdHint && activeTabKey === 'current' && (
            <Alert className='mb-4 border-emerald-200 bg-emerald-50 text-emerald-900 shadow-sm'>
              <div className='flex flex-col gap-3 md:flex-row md:items-center md:justify-between'>
                <div>
                  <AlertTitle className='text-sm font-semibold'>离线快照视图（未连通）</AlertTitle>
                  <AlertDescription className='mt-1 text-[11px] md:text-xs'>
                    <div>
                      当前展示的是上次记录的局数据，Game ID：
                      <span className='ml-1 font-mono text-xs md:text-sm'>{storedGameIdHint}</span>
                    </div>
                    <div className='mt-1 text-[11px] text-emerald-800'>
                      你暂时尚未与对方建立 P2P 连接，可以先查看比分与时间线；完成下方“建立 P2P 连接”后，将由房主自动下发最新状态并继续本局。
                    </div>
                  </AlertDescription>
                </div>
                <div className='flex flex-shrink-0 flex-col items-stretch gap-1 md:items-end'>
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='h-8 rounded-full border-emerald-300 bg-emerald-50 px-3 text-[11px] text-emerald-800 hover:bg-emerald-100'
                    onClick={handleDiscardSnapshotFromBanner}
                  >
                    丢弃快照
                  </Button>
                  <span className='text-[11px] text-emerald-700'>
                    丢弃后会清理本地记录并回到全新局的初始状态。
                  </span>
                </div>
              </div>
            </Alert>
          )}

          <Tabs
            value={activeTabKey}
            onValueChange={handleChangeHistoryTab}
            className='flex-1 w-full'
          >
            <TabsList className='mb-2 flex flex-wrap gap-1 rounded-full bg-slate-50 p-1'>
              <TabsTrigger value='current' className='px-3 py-1 text-[11px]'>
                当前对局
              </TabsTrigger>
              <TabsTrigger value='history-list' className='px-3 py-1 text-[11px]'>
                历史记录
              </TabsTrigger>
              {openHistoryTabs.map((tab) => (
                <TabsTrigger
                  key={tab.gameId}
                  value={`hist-${tab.gameId}`}
                  className='flex items-center gap-1 px-3 py-1 text-[11px]'
                >
                  <span className='max-w-[96px] truncate'>{tab.title}</span>
                  <button
                    type='button'
                    className='text-[11px] text-slate-400 hover:text-slate-700'
                    onClick={(event) => handleCloseHistoryTab(tab.gameId, event)}
                  >
                    ×
                  </button>
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value='current'>
              <div className='grid flex-1 gap-4 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] md:gap-6'>
            <div className='flex flex-col gap-4 md:gap-5'>
              <Card className='border-slate-200/80 shadow-sm'>
                <CardHeader className='pb-3'>
                  <div className='flex items-center justify-between gap-2'>
                    <div>
                      <CardTitle className='flex items-center gap-2 text-base'>
                        <Users className='h-4 w-4 text-slate-500' />
                        <span>步骤 1 · 选择你的阵营</span>
                      </CardTitle>
                      <CardDescription className='mt-1 text-xs text-slate-600'>
                        在本次连接会话内确定你的阵营，只能为“对方”加分；点击右侧“新开一局”可重置本局并重新选择阵营，如当前仍在进行中的一局会先弹出确认提示，放弃本次快照并重置。
                      </CardDescription>
                    </div>
                    <Button
                      type='button'
                      size='sm'
                      className='inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-200'
                      onClick={handleNewGameClick}
                    >
                      新开一局
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className='space-y-3'>
                  <div className='grid grid-cols-2 gap-3'>
                    <Button
                      type='button'
                      variant={lockedRole === 'red' ? 'default' : 'outline'}
                      className={`flex h-16 flex-col items-start justify-center gap-1 rounded-xl border text-left text-xs md:h-20 md:text-sm ${
                        lockedRole === 'red'
                          ? 'border-rose-500 bg-rose-50 text-rose-700 hover:bg-rose-100'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-rose-50/60 hover:text-rose-700'
                      }`}
                      onClick={() => handleSelectRole('red')}
                      disabled={roleLocked}
                    >
                      <span className='inline-flex items-center gap-2'>
                        <span className='inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[11px] font-semibold text-white'>
                          R
                        </span>
                        <span className='font-semibold'>红方 Red</span>
                      </span>
                      <span className='text-[11px] text-rose-700/80'>
                        你看到的是“为蓝方 +1”的按钮。
                      </span>
                    </Button>

                    <Button
                      type='button'
                      variant={lockedRole === 'blue' ? 'default' : 'outline'}
                      className={`flex h-16 flex-col items-start justify-center gap-1 rounded-xl border text-left text-xs md:h-20 md:text-sm ${
                        lockedRole === 'blue'
                          ? 'border-sky-500 bg-sky-50 text-sky-700 hover:bg-sky-100'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-sky-50/60 hover:text-sky-700'
                      }`}
                      onClick={() => handleSelectRole('blue')}
                      disabled={roleLocked}
                    >
                      <span className='inline-flex items-center gap-2'>
                        <span className='inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-500 text-[11px] font-semibold text-white'>
                          B
                        </span>
                        <span className='font-semibold'>蓝方 Blue</span>
                      </span>
                      <span className='text-[11px] text-sky-700/80'>
                        你看到的是“为红方 +1”的按钮。
                      </span>
                    </Button>
                  </div>
                  <p className='text-[11px] text-slate-500'>
                    建议一人选择红方、一人选择蓝方。角色在本次连接会话内锁定，不随每局重置；发起方的选择为最终方案，加入方在连接建立后会自动被分配为相反颜色。
                  </p>
                  {roleSyncMessage && (
                    <p className='rounded-md bg-slate-50 px-3 py-2 text-[11px] text-slate-700'>
                      {roleSyncMessage}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card className='border-slate-200/80 shadow-sm'>
                <CardHeader className='pb-3'>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Link2 className='h-4 w-4 text-slate-500' />
                    <span>步骤 2 · 建立 P2P 连接</span>
                  </CardTitle>
                  <CardDescription className='text-xs text-slate-600'>
                    一人作为“创建房间”，另一人作为“加入房间”，通过复制粘贴 Offer / Answer 完成信令交换。
                  </CardDescription>
                </CardHeader>
                <CardContent className='space-y-4'>
                  <Tabs
                    value={connectionMode}
                    onValueChange={(value) => handleChangeConnectionMode(value as ConnectionMode)}
                    className='w-full'
                  >
                    <TabsList className='grid w-full grid-cols-2 bg-slate-50'>
                      <TabsTrigger
                        value='offer'
                        className='flex items-center gap-1.5 text-[11px] md:text-xs'
                      >
                        <span className='inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-[10px] font-semibold text-slate-50'>
                          1
                        </span>
                        创建房间（发起方）
                      </TabsTrigger>
                      <TabsTrigger
                        value='answer'
                        className='flex items-center gap-1.5 text-[11px] md:text-xs'
                      >
                        <span className='inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-[10px] font-semibold text-slate-50'>
                          2
                        </span>
                        加入房间（应答方）
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value='offer' className='pt-4'>
                      <div className='space-y-3'>
                        <ol className='list-decimal space-y-1 pl-4 text-[11px] text-slate-600'>
                          <li>点击下方“生成 Offer”，等待几秒钟直至文本生成。</li>
                          <li>复制生成的 Offer 文本，通过任意 IM 工具发给对方。</li>
                          <li>对方生成 Answer 后，把完整 Answer 文本粘贴回下方输入框并应用。</li>
                        </ol>
                        <div className='flex flex-wrap items-center justify-between gap-2'>
                          <div className='flex items-center gap-2 text-[11px] text-slate-600'>
                            <Badge
                              variant='outline'
                              className='border-slate-200 bg-slate-50 text-[11px] font-normal text-slate-700'
                            >
                              发起方 · 创建房间
                            </Badge>
                            <span>你将先生成 Offer。</span>
                          </div>
                          <Button
                            type='button'
                            size='sm'
                            className='inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 text-[11px] font-medium text-slate-50 hover:bg-slate-800'
                            onClick={handleCreateOffer}
                          >
                            <Link2 className='h-3.5 w-3.5' />
                            生成 Offer
                          </Button>
                        </div>
                        <div className='space-y-1.5'>
                          <Label className='text-[11px] text-slate-700'>
                            本地 Offer + ICE（生成后复制给对方）
                          </Label>
                          <Textarea
                            className='h-28 resize-none rounded-xl border-slate-200 bg-slate-50 text-[11px]'
                            value={localSdp}
                            readOnly
                            placeholder='点击“生成 Offer”后，这里会出现 JSON 文本。请完整复制，勿修改任意字符。'
                          />
                          <div className='flex items-center justify-between gap-2 text-[11px] text-slate-500'>
                            <span>文本为标准 JSON 字符串，包含 SDP 与 ICE 信息。</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type='button'
                                  variant='outline'
                                  size='sm'
                                  className='h-7 rounded-full border-slate-200 px-2 text-[11px]'
                                  onClick={handleCopyLocalSdp}
                                  disabled={!localSdp}
                                >
                                  复制 Offer
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side='left' className='text-[11px]'>
                                复制失败时请手动全选后复制。
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                        <div className='space-y-1.5'>
                          <Label className='text-[11px] text-slate-700'>
                            对方 Answer JSON（粘贴后点击应用）
                          </Label>
                          <Textarea
                            className='h-24 resize-none rounded-xl border-slate-200 bg-white text-[11px]'
                            value={remoteSdp}
                            onChange={(e) => setRemoteSdp(e.target.value)}
                            placeholder='请让对方将 Answer JSON 文本发给你，完整粘贴在此处。'
                          />
                          <div className='flex justify-end'>
                            <Button
                              type='button'
                              size='sm'
                              className='h-8 rounded-full bg-slate-900 px-3 text-[11px] font-medium text-slate-50 hover:bg-slate-800'
                              onClick={handleApplyRemoteAnswer}
                            >
                              应用 Answer 并连接
                            </Button>
                          </div>
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value='answer' className='pt-4'>
                      <div className='space-y-3'>
                        <ol className='list-decimal space-y-1 pl-4 text-[11px] text-slate-600'>
                          <li>从发起方处获取其生成的 Offer JSON 文本。</li>
                          <li>完整粘贴到下方输入框，点击“应用 Offer 并生成 Answer”。</li>
                          <li>等待几秒钟，复制生成的 Answer 文本发回给对方即可。</li>
                        </ol>
                        <div className='flex flex-wrap items-center justify-between gap-2'>
                          <div className='flex items-center gap-2 text-[11px] text-slate-600'>
                            <Badge
                              variant='outline'
                              className='border-slate-200 bg-slate-50 text-[11px] font-normal text-slate-700'
                            >
                              应答方 · 加入房间
                            </Badge>
                            <span>你将先粘贴对方的 Offer。</span>
                          </div>
                          <Button
                            type='button'
                            size='sm'
                            className='inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 text-[11px] font-medium text-slate-50 hover:bg-slate-800'
                            onClick={handleApplyOfferAndCreateAnswer}
                          >
                            <Link2 className='h-3.5 w-3.5' />
                            应用 Offer 并生成 Answer
                          </Button>
                        </div>
                        <div className='space-y-1.5'>
                          <Label className='text-[11px] text-slate-700'>
                            对方 Offer JSON（完整粘贴在此处）
                          </Label>
                          <Textarea
                            className='h-24 resize-none rounded-xl border-slate-200 bg-white text-[11px]'
                            value={remoteSdp}
                            onChange={(e) => setRemoteSdp(e.target.value)}
                            placeholder='从发起方复制过来的 Offer JSON 文本，勿修改内容。'
                          />
                        </div>
                        <div className='space-y-1.5'>
                          <Label className='text-[11px] text-slate-700'>
                            本地 Answer + ICE（生成后复制给对方）
                          </Label>
                          <Textarea
                            className='h-28 resize-none rounded-xl border-slate-200 bg-slate-50 text-[11px]'
                            value={localSdp}
                            readOnly
                            placeholder='点击上方按钮后，这里会生成 Answer JSON 文本，请完整复制发给发起方。'
                          />
                          <div className='flex items-center justify-between gap-2 text-[11px] text-slate-500'>
                            <span>只有当此处出现完整 JSON 文本时，才说明 ICE 收集完成。</span>
                            <Button
                              type='button'
                              variant='outline'
                              size='sm'
                              className='h-7 rounded-full border-slate-200 px-2 text-[11px]'
                              onClick={handleCopyLocalSdp}
                              disabled={!localSdp}
                            >
                              复制 Answer
                            </Button>
                          </div>
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>
                </CardContent>
                {statusMessage && (
                  <CardFooter className='border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-[11px] text-slate-600'>
                    {statusMessage}
                  </CardFooter>
                )}
              </Card>

              <Card className='border-slate-200/80 shadow-sm'>
                <CardHeader className='pb-3'>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Timer className='h-4 w-4 text-slate-500' />
                    <span>步骤 3 · 设置结束时间点并开始本局</span>
                  </CardTitle>
                  <CardDescription className='text-xs text-slate-600'>
                    开局时约定一个固定的结束时间点，到达该时间或双方同意立即结束时，本局自动锁定投票并生成统计与曲线。
                  </CardDescription>
                </CardHeader>
                <CardContent className='space-y-4'>
                  <div className='flex flex-col gap-3 md:flex-row md:items-center md:justify-between'>
                    <div className='space-y-2'>
                      <Label className='text-[11px] text-slate-700'>
                        本局结束时间
                      </Label>
                      <div className='flex items-center gap-2'>
                        <Input
                          type='datetime-local'
                          className='h-8 rounded-full border-slate-200 bg-white px-3 text-[11px]'
                          value={initialEndTimeInput}
                          onChange={(e) => setInitialEndTimeInput(e.target.value)}
                        />
                        <span className='text-[11px] text-slate-500'>
                          默认约为当前时间后 10 分钟，可按需调整。
                        </span>
                      </div>
                    </div>
                    <div className='space-y-1 text-[11px] text-slate-600'>
                      <div>
                        本地显示的结束时间：
                        <span className='font-medium text-slate-900'>
                          {displayResolvedEndTimeSec
                            ? formatUnixSecondsToLocal(displayResolvedEndTimeSec)
                            : '尚未开始本局'}
                        </span>
                      </div>
                      <div className='text-[11px] text-slate-500'>
                        剩余时间根据各自浏览器时间计算，不要求双方系统时间完全一致。
                      </div>
                    </div>
                  </div>

                  <Separator className='my-2 bg-slate-100' />

                  <div className='flex flex-col gap-3 md:flex-row md:items-center md:justify-between'>
                    <div className='space-y-1 text-[11px] text-slate-600'>
                      <div>
                        当前剩余时间：
                        <span className='ml-1 inline-flex items-baseline gap-1 rounded-full bg-slate-900 px-2.5 py-0.5 text-xs font-semibold tracking-tight text-slate-50'>
                          <Timer className='h-3 w-3' />
                          <span className='tabular-nums'>{displayTimeLabel}</span>
                        </span>
                      </div>
                      <div className='text-[11px] text-slate-500'>
                        建议由一方点击“开始本局”，另一方看到结束时间与倒计时同步变化即可。
                      </div>
                    </div>
                    <div className='flex flex-wrap items-center gap-2'>
                      <Button
                        type='button'
                        size='sm'
                        className='inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-200'
                        onClick={handleStartGame}
                        disabled={!isConnected || gameState === 'running'}
                      >
                        <Gamepad2 className='h-3.5 w-3.5' />
                        开始本局
                      </Button>
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        className='inline-flex items-center gap-1.5 rounded-full border-slate-200 px-3 text-[11px] text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'
                        onClick={handleNewGameClick}
                        disabled={false}
                      >
                        新开一局
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className='border-slate-200/80 shadow-sm'>
                <CardHeader className='pb-3'>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Timer className='h-4 w-4 text-slate-500' />
                    <span>协商修改结束时间 / 立即结束</span>
                  </CardTitle>
                  <CardDescription className='text-xs text-slate-600'>
                    在本局进行中，可向对方提议调整结束时间或立即结束，只有对方同意后才会真正生效。
                  </CardDescription>
                </CardHeader>
                <CardContent className='space-y-3'>
                  <div className='space-y-2'>
                    <Label className='text-[11px] text-slate-700'>
                      提议的新结束时间
                    </Label>
                    <div className='flex items-center gap-2'>
                      <Input
                        type='datetime-local'
                        className='h-8 rounded-full border-slate-200 bg-white px-3 text-[11px]'
                        value={proposedEndTimeInput || initialEndTimeInput}
                        onChange={(e) => setProposedEndTimeInput(e.target.value)}
                      />
                      <span className='text-[11px] text-slate-500'>
                        仅在本局进行中有效，建议基于当前结束时间适度延后或提前。
                      </span>
                    </div>
                  </div>
                  <div className='flex flex-wrap items-center gap-2'>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-8 rounded-full border-slate-200 px-3 text-[11px] text-slate-700 disabled:cursor-not-allowed disabled:opacity-60'
                      onClick={handleProposeEndChange}
                      disabled={!isConnected || gameState !== 'running' || !currentRoundId}
                    >
                      提议延后/提前结束时间
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-8 rounded-full border-red-200 bg-red-50 px-3 text-[11px] text-red-700 disabled:cursor-not-allowed disabled:opacity-60'
                      onClick={handleProposeEndNow}
                      disabled={!isConnected || gameState !== 'running' || !currentRoundId}
                    >
                      提议立即结束本局
                    </Button>
                  </div>
                  {infoMessage && (
                    <div className='rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600'>
                      {infoMessage}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className='flex flex-col gap-4 md:gap-5'>
              <Card className='border-slate-200/80 shadow-sm'>
                <CardHeader className='pb-3'>
                  <CardTitle className='flex items-center justify-between text-base'>
                    <span className='flex items-center gap-2'>
                      <Gamepad2 className='h-4 w-4 text-slate-500' />
                      <span>步骤 4 · 实时对战与比分板</span>
                    </span>
                    <Badge
                      variant='outline'
                      className='border-slate-200 bg-slate-50 text-[11px] font-normal text-slate-700'
                    >
                      {resultLabel}
                    </Badge>
                  </CardTitle>
                  <CardDescription className='text-xs text-slate-600'>
                    你只能为对方加分，比分通过 WebRTC DataChannel 实时同步到对端。
                  </CardDescription>
                </CardHeader>
                <CardContent className='space-y-4'>
                  <div className='grid gap-3 md:grid-cols-2'>
                    <div className='rounded-2xl border border-rose-100 bg-rose-50/80 p-3 shadow-[0_10px_30px_rgba(248,113,113,0.15)]'>
                      <div className='flex items-center justify-between gap-2'>
                        <div className='flex items-center gap-2'>
                          <span className='inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-xs font-bold text-white'>
                            R
                          </span>
                          <div>
                            <div className='text-xs font-semibold text-rose-800'>红方</div>
                            <div className='text-[11px] text-rose-700/80'>Red team</div>
                          </div>
                        </div>
                        <Badge className='border-none bg-rose-600/90 text-[11px] font-medium text-rose-50 shadow-sm'>
                          {lockedRole === 'red' ? '你自己' : '对手'}
                        </Badge>
                      </div>
                      <div className='mt-3 text-3xl font-black tracking-tight text-rose-600 md:text-4xl'>
                        <span className='tabular-nums'>{displayScores.red}</span>
                      </div>
                    </div>

                    <div className='rounded-2xl border border-sky-100 bg-sky-50/80 p-3 shadow-[0_10px_30px_rgba(56,189,248,0.18)]'>
                      <div className='flex items-center justify-between gap-2'>
                        <div className='flex items-center gap-2'>
                          <span className='inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-500 text-xs font-bold text-white'>
                            B
                          </span>
                          <div>
                            <div className='text-xs font-semibold text-sky-800'>蓝方</div>
                            <div className='text-[11px] text-sky-700/80'>Blue team</div>
                          </div>
                        </div>
                        <Badge className='border-none bg-sky-600/90 text-[11px] font-medium text-sky-50 shadow-sm'>
                          {lockedRole === 'blue' ? '你自己' : '对手'}
                        </Badge>
                      </div>
                      <div className='mt-3 text-3xl font-black tracking-tight text-sky-600 md:text-4xl'>
                        <span className='tabular-nums'>{displayScores.blue}</span>
                      </div>
                    </div>
                  </div>

                  <div className='flex flex-col gap-3 rounded-2xl bg-slate-50/80 p-3 md:flex-row md:items-center md:justify-between'>
                    <div className='space-y-1 text-[11px] text-slate-600'>
                      <div>
                        倒计时：
                        <span className='ml-1 inline-flex items-baseline gap-1 rounded-full bg-slate-900 px-2.5 py-0.5 text-xs font-semibold tracking-tight text-slate-50'>
                          <Timer className='h-3 w-3' />
                          <span className='tabular-nums'>{displayTimeLabel}</span>
                        </span>
                      </div>
                      <div>
                        总得分：
                        <span className='font-medium text-slate-900'>红方 {displayScores.red}</span>
                        <span className='mx-1 text-slate-400'>/</span>
                        <span className='font-medium text-slate-900'>蓝方 {displayScores.blue}</span>
                      </div>
                      {(historyViewSnapshot?.gameState === 'ended' || gameState === 'ended') && (
                        <div className='text-[11px] text-slate-500'>
                          本局已结束，你可以在下方查看最终统计与得分曲线，或点击“新开一局”开始下一回合。
                        </div>
                      )}
                    </div>
                    <div className='flex flex-col items-stretch gap-1 md:items-end'>
                      <Button
                        type='button'
                        disabled={!isConnected || gameState !== 'running' || !lockedRole}
                        onClick={handleVote}
                        className={`inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-xs font-semibold shadow-sm transition-colors md:text-sm ${
                          lockedRole === 'red'
                            ? 'bg-sky-600 text-sky-50 hover:bg-sky-700 disabled:bg-sky-200'
                            : 'bg-rose-600 text-rose-50 hover:bg-rose-700 disabled:bg-rose-200'
                        } disabled:cursor-not-allowed`}
                      >
                        <span>
                          为{' '}
                          <span className='font-bold'>
                            {lockedRole === 'red' && '蓝方 Blue'}
                            {lockedRole === 'blue' && '红方 Red'}
                            {!lockedRole && '对方'}
                          </span>{' '}
                          +1
                        </span>
                      </Button>
                      <span className='text-[11px] text-slate-500'>
                        按钮始终只会给“对方”的分数板加 1，本地与远端会保持同步。
                      </span>
                      {voteIgnoreMessage && (
                        <span className='text-[11px] text-amber-700'>{voteIgnoreMessage}</span>
                      )}
                      {offlineSnapshotMode && !isConnected && (
                        <span className='text-[11px] text-emerald-700'>
                          当前为离线快照视图，投票按钮已禁用，请先在上方完成 P2P 连接后再继续本局。
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className='border-slate-200/80 shadow-sm'>
                <CardHeader className='pb-3'>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <LineChartIcon className='h-4 w-4 text-slate-500' />
                    <span>步骤 5 · 截止结算与得分曲线</span>
                  </CardTitle>
                  <CardDescription className='text-xs text-slate-600'>
                    使用 Recharts 绘制双方随时间变化的累计得分曲线，时间粒度为秒。
                  </CardDescription>
                </CardHeader>
                <CardContent className='space-y-3'>
                  <div className='grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]'>
                    <div className='h-52 rounded-xl border border-slate-100 bg-slate-50/70 p-2 md:h-60'>
                      {chartData.length > 0 ? (
                        <ResponsiveContainer width='100%' height='100%'>
                          <RechartsLineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                            <CartesianGrid strokeDasharray='3 3' stroke='#e5e7eb' />
                            <XAxis
                              dataKey='second'
                              tickLine={false}
                              axisLine={false}
                              tickMargin={8}
                              tick={{ fontSize: 11, fill: '#6b7280' }}
                              label={{ value: '秒（从本局开始算起）', position: 'insideBottom', offset: -2, fontSize: 10, fill: '#9ca3af' }}
                            />
                            <YAxis
                              tickLine={false}
                              axisLine={false}
                              width={28}
                              tickMargin={4}
                              allowDecimals={false}
                              tick={{ fontSize: 11, fill: '#6b7280' }}
                            />
                            <RechartsTooltip
                              contentStyle={{ fontSize: 11 }}
                              labelFormatter={(value) => `第 ${value} 秒`}
                            />
                            <Legend
                              verticalAlign='top'
                              align='right'
                              height={24}
                              iconSize={10}
                              formatter={(value) => (
                                <span className='text-[11px] text-slate-600'>{value}</span>
                              )}
                            />
                            <Line
                              type='monotone'
                              dataKey='red'
                              name='红方累计得分'
                              stroke='#f97373'
                              strokeWidth={2}
                              dot={{ r: 2 }}
                              activeDot={{ r: 3 }}
                              isAnimationActive={false}
                            />
                            <Line
                              type='monotone'
                              dataKey='blue'
                              name='蓝方累计得分'
                              stroke='#0ea5e9'
                              strokeWidth={2}
                              dot={{ r: 2 }}
                              activeDot={{ r: 3 }}
                              isAnimationActive={false}
                            />
                          </RechartsLineChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className='flex h-full items-center justify-center text-center text-[11px] text-slate-500'>
                          倒计时结束后，这里会显示本局的红蓝双方累计得分曲线。
                          <br />
                          在对局进行中，你也可以实时看到曲线变化。
                        </div>
                      )}
                    </div>

                    <div className='space-y-2 text-[11px] text-slate-600'>
                      <div className='rounded-xl border border-slate-100 bg-slate-50/70 p-3'>
                        <div className='mb-1 text-xs font-semibold text-slate-800'>本局统计</div>
                        <div className='space-y-1'>
                          <div>
                            红方总分：
                            <span className='font-semibold text-rose-700'>{displayScores.red}</span>
                          </div>
                          <div>
                            蓝方总分：
                            <span className='font-semibold text-sky-700'>{displayScores.blue}</span>
                          </div>
                          <div>
                            分差：
                            <span className='font-semibold text-slate-900'>
                              {scoreDiff === 0 && '0（平局）'}
                              {scoreDiff > 0 && `红方领先 ${scoreDiff}`}
                              {scoreDiff < 0 && `蓝方领先 ${Math.abs(scoreDiff)}`}
                            </span>
                          </div>
                          <div>
                            本局时长：
                            <span className='font-semibold text-slate-900'>
                              {gameDuration ? `${gameDuration} 秒` : '尚未开始'}
                            </span>
                          </div>
                          <div>
                            本局 Game ID：
                            {displayGameId ? (
                              <span className='ml-1 inline-flex max-w-full items-center gap-1 rounded-full bg-slate-900 px-2.5 py-0.5 text-[11px] font-mono text-slate-50'>
                                <span className='truncate'>{displayGameId}</span>
                              </span>
                            ) : (
                              <span className='ml-1 font-semibold text-slate-900'>
                                尚未生成（开始本局时自动创建）
                              </span>
                            )}
                          </div>
                          {displayGameId && (
                            <div className='mt-1 flex flex-wrap items-center gap-2'>
                              <Button
                                type='button'
                                variant='outline'
                                size='sm'
                                className='h-7 rounded-full border-slate-200 px-2 text-[11px]'
                                onClick={handleCopyGameId}
                              >
                                <Copy className='mr-1 h-3 w-3' />
                                复制 Game ID
                              </Button>
                              {gameIdCopyMessage && (
                                <span className='text-[11px] text-slate-500'>{gameIdCopyMessage}</span>
                              )}
                            </div>
                          )}
                          <div>
                            当前快照：
                            {snapshotMeta ? (
                              <span className='font-semibold text-slate-900'>
                                版本 v{snapshotMeta.version} · 更新时间{' '}
                                {formatUnixSecondsToLocal(
                                  Math.floor(snapshotMeta.lastUpdatedAt / 1000),
                                )}
                              </span>
                            ) : (
                              <span className='font-semibold text-slate-900'>
                                尚未生成（本局开始并产生状态后会自动记录到浏览器）
                              </span>
                            )}
                          </div>
                          {snapshotMeta && (currentRoundId || currentGameId) && (
                            <div className='mt-1 flex flex-wrap items-center gap-2'>
                              <Button
                                type='button'
                                variant='outline'
                                size='sm'
                                className='h-7 rounded-full border-slate-200 px-2 text-[11px]'
                                onClick={handleDiscardSnapshotFromStats}
                              >
                                丢弃快照
                              </Button>
                              <span className='text-[11px] text-slate-500'>
                                仅清理本地快照，不影响当前正在进行的连接与比分。
                              </span>
                            </div>
                          )}
                          <div>
                            时间粒度：<span className='font-semibold text-slate-900'>1 秒</span>（每秒汇总本地与远端的投票事件）。
                          </div>
                        </div>
                      </div>

                      <div className='rounded-xl border border-slate-100 bg-white/80 p-3'>
                        <div className='mb-1 text-xs font-semibold text-slate-800'>
                          使用说明（简要）
                        </div>
                        <ol className='list-decimal space-y-1.5 pl-4'>
                          <li>
                            <span className='font-medium text-slate-900'>选择角色</span>：一人选红方，一人选蓝方；角色在本次连接会话内锁定，不随每局重置。发起方的选择为最终方案，连接建立后加入方会自动被分配为相反颜色且不可修改。
                          </li>
                          <li>
                            <span className='font-medium text-slate-900'>建立连接</span>：一人在“创建房间”生成 Offer 文本发出；另一人在“加入房间”粘贴 Offer 生成 Answer 并发回；发起方粘贴 Answer 后，P2P 连接建立。
                          </li>
                          <li>
                            <span className='font-medium text-slate-900'>设置结束时间并开始本局</span>：在步骤 3 选择一个具体的结束时间点（默认当前时间后约 10 分钟），任意一方点击“开始本局”，由房主生成一个高熵的 Game ID，双方会共享同一个 Game ID（同时作为 roundId 用于消息校验）与结束时间，剩余时间按各自浏览器时间计算，该 ID 也会写入本地用于刷新后的恢复提示，不易被猜测。
                          </li>
                          <li>
                            <span className='font-medium text-slate-900'>离线快照与刷新恢复</span>
                            ：本局进行中时，关键状态（Game ID、比分、开始/结束时间、投票时间线等）会自动保存到浏览器本地；刷新后若尚未重新连通，你会看到顶部的“离线快照视图（未连通）”提示，并以快照数据渲染比分和曲线，投票按钮会保持禁用。重新完成 P2P 连接后，由房主自动发送最新状态快照到对端，客方界面会用该快照覆盖当前 UI 并解除禁用。
                          </li>
                          <li>
                            <span className='font-medium text-slate-900'>投票与结束</span>：在步骤 4 中，只能使用大按钮为“对方阵营 +1”——红方只能给蓝方 +1，蓝方只能给红方 +1。所有投票消息都带有 roundId（即本局 Game ID），旧局或旧页面发出的投票会被自动忽略；到达约定结束时间或双方同意“立即结束”后，本局将锁定，无法继续投票。
                          </li>
                          <li>
                            <span className='font-medium text-slate-900'>重开一局</span>：在保持 P2P 连接不变的前提下，可以在步骤 3 重新选择结束时间点并点击“开始本局”；也可以先点击“新开一局”快速重置本局状态，再设置结束时间后开始下一回合，系统会生成新的 roundId，但沿用当前会话锁定的红/蓝阵营。
                          </li>
                          <li>
                            <span className='font-medium text-slate-900'>历史记录与只读查看</span>
                            ：每当一局结束时，系统会将该局的 Game ID、开始/结束时间、最终红蓝比分和投票时间线写入“历史对局记录”卡片。你可以在右侧列表中点击“加载只读”进入历史只读模式，查看该局的最终比分与累计曲线；此时所有投票和结束时间相关操作都会被禁用，可通过顶部提示的“返回当前会话”按钮回到当前进行中的局或默认视图，也可以在列表中删除不再需要的历史记录。
                          </li>
                        </ol>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>


            </div>
              </div>
            </TabsContent>

            <TabsContent value='history-list' className='mt-4'>
              <Card className='border-slate-200/80 shadow-sm'>
                <CardHeader className='pb-3'>
                  <CardTitle className='flex items-center gap-2 text-base'>
                    <Timer className='h-4 w-4 text-slate-500' />
                    <span>历史对局记录（仅本机）</span>
                  </CardTitle>
                  <CardDescription className='text-xs text-slate-600'>
                    每当一局结束时，系统会自动将最终比分、时长和 Game ID 保存在浏览器本地，你可以在此加载历史对局进行只读查看或删除记录。
                  </CardDescription>
                </CardHeader>
                <CardContent className='space-y-3'>
                  {historyError && (
                    <div className='rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700'>
                      {historyError}
                    </div>
                  )}
                  {historyIndex.length === 0 ? (
                    <div className='rounded-lg border border-dashed border-slate-200 bg-slate-50/60 px-3 py-3 text-[11px] text-slate-500'>
                      当前还没有历史对局记录。完成一局并结束后，这里会自动出现该局的 Game ID、结束时间和最终比分。
                    </div>
                  ) : (
                    <div className='space-y-2'>
                      {historyIndex.map((item) => {
                        const isActive = historyViewSnapshot?.gameId === item.gameId
                        const durationSec = Math.max(0, item.endTimeSec - item.startTimeSec)
                        return (
                          <div
                            key={item.gameId}
                            className='flex flex-col gap-1 rounded-lg border border-slate-100 bg-slate-50/80 p-2.5'
                          >
                            <div className='flex items-center justify-between gap-2'>
                              <div className='min-w-0'>
                                <div className='flex items-center gap-2'>
                                  <span className='max-w-[180px] truncate font-mono text-[11px]'>
                                    {item.gameId}
                                  </span>
                                  {isActive && (
                                    <Badge
                                      variant='outline'
                                      className='border-sky-200 bg-sky-50 text-[10px] font-normal text-sky-700'
                                    >
                                      已加载
                                    </Badge>
                                  )}
                                </div>
                                <div className='mt-0.5 text-[11px] text-slate-500'>
                                  结束时间：{formatUnixSecondsToLocal(item.endTimeSec)}
                                </div>
                              </div>
                              <div className='text-right text-[11px]'>
                                <div>
                                  红 {item.scoreRed} / 蓝 {item.scoreBlue}
                                </div>
                                <div className='text-slate-500'>时长 {durationSec} 秒</div>
                              </div>
                            </div>
                            <div className='flex flex-wrap items-center justify-between gap-2 pt-1'>
                              <div className='text-[11px] text-slate-400'>
                                最后更新：
                                {formatUnixSecondsToLocal(Math.floor(item.lastUpdatedAt / 1000))}
                              </div>
                              <div className='flex gap-2'>
                                <Button
                                  type='button'
                                  size='sm'
                                  variant='outline'
                                  className='h-7 rounded-full border-slate-200 px-2 text-[11px]'
                                  onClick={() => handleLoadHistoryGame(item.gameId)}
                                >
                                  加载只读
                                </Button>
                                <Button
                                  type='button'
                                  size='sm'
                                  variant='outline'
                                  className='h-7 rounded-full border-red-200 bg-red-50 px-2 text-[11px] text-red-700'
                                  onClick={() => handleDeleteHistoryGame(item.gameId)}
                                >
                                  删除
                                </Button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {openHistoryTabs.map((tab) => {
              const snapshot = historyViewSnapshots[tab.gameId]
              const histScores = snapshot
                ? { red: snapshot.scoreRed, blue: snapshot.scoreBlue }
                : null
              const histScoreDiff = histScores ? histScores.red - histScores.blue : 0
              const histDuration = snapshot
                ? Math.max(0, snapshot.endTimeSec - snapshot.startTimeSec)
                : null
              const histChartData = snapshot ? buildChartDataForSnapshot(snapshot) : []

              return (
                <TabsContent key={tab.gameId} value={`hist-${tab.gameId}`} className='mt-4'>
                  {snapshot ? (
                    <Card className='border-slate-200/80 shadow-sm'>
                      <CardHeader className='pb-3'>
                        <CardTitle className='flex items-center justify-between text-base'>
                          <span className='flex items-center gap-2'>
                            <Gamepad2 className='h-4 w-4 text-slate-500' />
                            <span>历史对局 · 最终状态与曲线</span>
                          </span>
                          <Badge
                            variant='outline'
                            className='border-slate-200 bg-slate-50 text-[11px] font-normal text-slate-700'
                          >
                            {histScoreDiff === 0
                              ? '平局'
                              : histScoreDiff > 0
                                ? `红方胜出 ${histScoreDiff}`
                                : `蓝方胜出 ${Math.abs(histScoreDiff)}`}
                          </Badge>
                        </CardTitle>
                        <CardDescription className='text-xs text-slate-600'>
                          Game ID：{snapshot.gameId} · 结束时间：
                          {formatUnixSecondsToLocal(snapshot.endTimeSec)} · 本局时长：
                          {histDuration !== null ? `${histDuration} 秒` : '未知'}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className='space-y-3'>
                        <div className='grid gap-3 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]'>
                          <div className='h-52 rounded-xl border border-slate-100 bg-slate-50/70 p-2 md:h-60'>
                            {histChartData.length > 0 ? (
                              <ResponsiveContainer width='100%' height='100%'>
                                <RechartsLineChart
                                  data={histChartData}
                                  margin={{ top: 8, right: 8, left: 0, bottom: 8 }}
                                >
                                  <CartesianGrid strokeDasharray='3 3' stroke='#e5e7eb' />
                                  <XAxis
                                    dataKey='second'
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={8}
                                    tick={{ fontSize: 11, fill: '#6b7280' }}
                                    label={{
                                      value: '秒（从本局开始算起）',
                                      position: 'insideBottom',
                                      offset: -2,
                                      fontSize: 10,
                                      fill: '#9ca3af',
                                    }}
                                  />
                                  <YAxis
                                    tickLine={false}
                                    axisLine={false}
                                    width={28}
                                    tickMargin={4}
                                    allowDecimals={false}
                                    tick={{ fontSize: 11, fill: '#6b7280' }}
                                  />
                                  <RechartsTooltip
                                    contentStyle={{ fontSize: 11 }}
                                    labelFormatter={(value) => `第 ${value} 秒`}
                                  />
                                  <Legend
                                    verticalAlign='top'
                                    align='right'
                                    height={24}
                                    iconSize={10}
                                    formatter={(value) => (
                                      <span className='text-[11px] text-slate-600'>{value}</span>
                                    )}
                                  />
                                  <Line
                                    type='monotone'
                                    dataKey='red'
                                    name='红方累计得分'
                                    stroke='#f97373'
                                    strokeWidth={2}
                                    dot={{ r: 2 }}
                                    activeDot={{ r: 3 }}
                                    isAnimationActive={false}
                                  />
                                  <Line
                                    type='monotone'
                                    dataKey='blue'
                                    name='蓝方累计得分'
                                    stroke='#0ea5e9'
                                    strokeWidth={2}
                                    dot={{ r: 2 }}
                                    activeDot={{ r: 3 }}
                                    isAnimationActive={false}
                                  />
                                </RechartsLineChart>
                              </ResponsiveContainer>
                            ) : (
                              <div className='flex h-full items-center justify-center text-center text-[11px] text-slate-500'>
                                该历史对局没有记录到详细的时间线，仅保留最终比分。
                              </div>
                            )}
                          </div>

                          <div className='space-y-1 text-[11px] text-slate-600'>
                            <div>
                              红方总分：
                              <span className='font-semibold text-rose-700'>{histScores?.red ?? 0}</span>
                            </div>
                            <div>
                              蓝方总分：
                              <span className='font-semibold text-sky-700'>{histScores?.blue ?? 0}</span>
                            </div>
                            <div>
                              分差：
                              <span className='font-semibold text-slate-900'>
                                {histScoreDiff === 0 && '0（平局）'}
                                {histScoreDiff > 0 && `红方领先 ${histScoreDiff}`}
                                {histScoreDiff < 0 && `蓝方领先 ${Math.abs(histScoreDiff)}`}
                              </span>
                            </div>
                            <div>
                              本局时长：
                              <span className='font-semibold text-slate-900'>
                                {histDuration !== null ? `${histDuration} 秒` : '未知'}
                              </span>
                            </div>
                            <div>
                              Game ID：
                              <span className='font-mono text-[11px]'>{snapshot.gameId}</span>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <Card className='border-slate-200/80 bg-slate-50/80 shadow-sm'>
                      <CardHeader className='pb-2'>
                        <CardTitle className='text-sm'>历史快照不可用</CardTitle>
                        <CardDescription className='text-xs text-slate-600'>
                          未在本地找到 Game ID 为 {tab.gameId} 的快照记录，可能已被清理。
                        </CardDescription>
                      </CardHeader>
                    </Card>
                  )}
                </TabsContent>
              )
            })}

          </Tabs>
        </main>
      </div>

      <AlertDialog
        open={newGameConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setNewGameConfirmOpen(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className='text-sm'>新开一局并重置当前对局？</AlertDialogTitle>
            <AlertDialogDescription className='text-[11px] text-slate-600'>
              当前仍在进行中的一局，若新开一局将放弃本次快照并重置。是否继续？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className='text-[11px]'>取消</AlertDialogCancel>
            <AlertDialogAction
              className='text-[11px]'
              onClick={() => {
                setNewGameConfirmOpen(false)
                handleStartNewRound()
              }}
            >
              确认新开一局
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!incomingEndChange}
        onOpenChange={(open) => {
          if (!open) {
            setIncomingEndChange(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className='text-sm'>对方请求修改结束时间</AlertDialogTitle>
            <AlertDialogDescription className='text-[11px] text-slate-600'>
              <div className='space-y-1'>
                <div>
                  新的结束时间：
                  <span className='font-medium text-slate-900'>
                    {pendingEndChangeSummary?.proposedLabel}
                  </span>
                </div>
                <div>
                  当前结束时间：
                  <span className='font-medium text-slate-900'>
                    {pendingEndChangeSummary?.currentLabel}
                  </span>
                </div>
                <div className='text-slate-500'>{pendingEndChangeSummary?.diffText}</div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className='text-[11px]'
              onClick={handleRejectIncomingEndChange}
            >
              拒绝
            </AlertDialogCancel>
            <AlertDialogAction
              className='text-[11px]'
              onClick={handleAcceptIncomingEndChange}
            >
              同意修改
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={incomingEndNow}
        onOpenChange={(open) => {
          if (!open) {
            setIncomingEndNow(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className='text-sm'>对方请求立即结束本局</AlertDialogTitle>
            <AlertDialogDescription className='text-[11px] text-slate-600'>
              对方希望立刻结束当前回合，结束后双方将无法继续投票，但可以保留连接查看统计或开启新一局。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className='text-[11px]'
              onClick={handleRejectIncomingEndNow}
            >
              继续对局
            </AlertDialogCancel>
            <AlertDialogAction
              className='text-[11px]'
              onClick={handleAcceptIncomingEndNow}
            >
              同意立即结束
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}

export default App
