const TOKEN_KEY = 'nessie.admin.token'
const COOKIE_PREFIX = 'nessie.admin.'

export const loadStoredToken = (): string | null => localStorage.getItem(TOKEN_KEY)

export const storeToken = (token: string): void => {
  localStorage.setItem(TOKEN_KEY, token)
}

export const clearStoredToken = (): void => {
  localStorage.removeItem(TOKEN_KEY)
}

export const getCookie = (name: string): string | null => {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${COOKIE_PREFIX}${name}=([^;]*)`)
  )
  return match ? decodeURIComponent(match[1]) : null
}

export const setCookie = (name: string, value: string, days = 365): void => {
  const expires = new Date(Date.now() + days * 864e5).toUTCString()
  document.cookie = `${COOKIE_PREFIX}${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`
}
