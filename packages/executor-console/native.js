// The local console is the same document on macOS and Windows. Only this
// process-local transport differs. Neither host permits remote navigation.
window.executorNative = window.__TAURI__ ? {
  invoke: (command, args) => window.__TAURI__.core.invoke(command === 'executor_describe' ? 'executor_console_describe' : command, args),
  listen: (event, handler) => window.__TAURI__.event.listen(event, handler),
} : {
  invoke: (command, args = {}) => window.webkit.messageHandlers.executor.postMessage({ command, args }),
  listen: (event, handler) => {
    window.addEventListener(event, handler)
    return Promise.resolve(() => window.removeEventListener(event, handler))
  },
}
