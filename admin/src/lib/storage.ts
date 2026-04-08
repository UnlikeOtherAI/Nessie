const TOKEN_KEY = 'nessie.admin.token'

export const loadStoredToken = (): string | null => localStorage.getItem(TOKEN_KEY)

export const storeToken = (token: string): void => {
  localStorage.setItem(TOKEN_KEY, token)
}

export const clearStoredToken = (): void => {
  localStorage.removeItem(TOKEN_KEY)
}
