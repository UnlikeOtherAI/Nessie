package main

import (
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

const (
	browserProfileDirectory = "/work/.nessie-executor/browser"
	browserProxyAddress     = "http://127.0.0.1:8137"
	maxBrowserURLBytes      = 4_096
)

type browserProcess interface {
	Kill() error
	Wait() error
}

type browserLauncher func(path string, args, environment []string) (browserProcess, error)

type browserRuntime struct {
	executable  string
	launch      browserLauncher
	profile     string
	profileRoot string
	mu          sync.Mutex
	process     browserProcess
	generation  uint64
}

func newBrowserRuntime(manifest *runtimeManifest) *browserRuntime {
	if manifest == nil || manifest.Entrypoints["browser"] == "" {
		return nil
	}
	return &browserRuntime{
		executable:  filepath.Join("/runtime", filepath.FromSlash(manifest.Entrypoints["browser"])),
		launch:      launchBrowserProcess,
		profile:     browserProfileDirectory,
		profileRoot: "/work",
	}
}

func validBrowserURL(raw string) bool {
	if raw == "" || len(raw) > maxBrowserURLBytes {
		return false
	}
	parsed, err := url.ParseRequestURI(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.Port() == "" && parsed.User == nil
}

func (browser *browserRuntime) open(rawURL string) error {
	if !validBrowserURL(rawURL) {
		return errInvalidFrame
	}
	browser.mu.Lock()
	defer browser.mu.Unlock()
	if browser.process != nil {
		return errInvalidFrame
	}
	if err := secureBrowserProfile(browser.profileRoot, browser.profile); err != nil {
		return err
	}
	process, err := browser.launch(browser.executable, fixedBrowserArguments(rawURL, browser.profile), browserEnvironment(browser.profile))
	if err != nil {
		return err
	}
	browser.process = process
	browser.generation++
	generation := browser.generation
	go func() {
		_ = process.Wait()
		browser.mu.Lock()
		if browser.generation == generation {
			browser.process = nil
		}
		browser.mu.Unlock()
	}()
	return nil
}

func secureBrowserProfile(root, profile string) error {
	relative, err := filepath.Rel(root, profile)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errInvalidFrame
	}
	current := root
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." {
			return errInvalidFrame
		}
		current = filepath.Join(current, part)
		if err := os.Mkdir(current, 0o700); err != nil && !os.IsExist(err) {
			return err
		}
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
			return errInvalidFrame
		}
		stat, isCurrentOwner := info.Sys().(*syscall.Stat_t)
		if !isCurrentOwner || stat.Uid != uint32(os.Geteuid()) {
			return errInvalidFrame
		}
	}
	return nil
}

func (browser *browserRuntime) close() {
	browser.mu.Lock()
	process := browser.process
	browser.process = nil
	browser.generation++
	browser.mu.Unlock()
	if process != nil {
		_ = process.Kill()
	}
}

func fixedBrowserArguments(rawURL, profile string) []string {
	return []string{
		"--disable-background-networking",
		"--disable-default-apps",
		"--disable-quic",
		"--no-default-browser-check",
		"--no-first-run",
		"--proxy-bypass-list=<-loopback>",
		"--proxy-server=" + browserProxyAddress,
		"--user-data-dir=" + profile,
		rawURL,
	}
}

func browserEnvironment(profile string) []string {
	return []string{
		"HOME=" + profile,
		"TMPDIR=" + profile,
	}
}

type execBrowserProcess struct {
	command *exec.Cmd
}

func (process *execBrowserProcess) Kill() error {
	return process.command.Process.Kill()
}

func (process *execBrowserProcess) Wait() error {
	return process.command.Wait()
}

func launchBrowserProcess(path string, args, environment []string) (browserProcess, error) {
	command := exec.Command(path, args...)
	command.Dir = "/work"
	command.Env = environment
	command.Stderr = io.Discard
	command.Stdout = io.Discard
	if err := command.Start(); err != nil {
		return nil, err
	}
	return &execBrowserProcess{command: command}, nil
}
