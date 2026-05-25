export function useTimeAgo() {
  function timeAgo(isoStr: string | null | undefined): string {
    if (!isoStr) return ''
    const diff = Date.now() - new Date(isoStr).getTime()
    const mins = Math.floor(diff / 60_000)
    if (mins < 1)  return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24)  return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  return { timeAgo }
}
