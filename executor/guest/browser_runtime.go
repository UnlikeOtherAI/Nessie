package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	browserProfileDirectory = "/work/.nessie-executor/browser"
	browserProxyAddress     = "http://127.0.0.1:8137"
	browserDevToolsAddress  = "127.0.0.1:9222"
	browserDevToolsURL      = "http://127.0.0.1:9222/json/list"
	maxBrowserURLBytes      = 4_096
	maxBrowserTargets       = 32
	maxBrowserObserveBytes  = 65_536
)

type browserProcess interface {
	Kill() error
	Wait() error
}

type browserLauncher func(path string, args, environment []string) (browserProcess, error)
type browserObserver func() (browserObservation, error)

type browserObservation struct {
	Targets []browserTarget `json:"targets"`
}

type browserTarget struct {
	Title string `json:"title"`
	Type  string `json:"type"`
	URL   string `json:"url"`
}

type browserRuntime struct {
	executable  string
	launch      browserLauncher
	observe     browserObserver
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
		observe:     observeBrowserTargets,
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

func (browser *browserRuntime) observation() (browserObservation, error) {
	browser.mu.Lock()
	active := browser.process != nil
	observer := browser.observe
	browser.mu.Unlock()
	if !active || observer == nil {
		return browserObservation{}, errInvalidFrame
	}
	return observer()
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
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=9222",
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

func observeBrowserTargets() (browserObservation, error) {
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       2 * time.Second,
		Transport: &http.Transport{
			DialContext: dialBrowserDevTools,
			Proxy:       nil,
		},
	}
	response, err := client.Get(browserDevToolsURL)
	if err != nil {
		return browserObservation{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return browserObservation{}, errInvalidFrame
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBrowserObserveBytes+1))
	if err != nil || len(body) > maxBrowserObserveBytes {
		return browserObservation{}, errInvalidFrame
	}
	var raw []struct {
		Title string `json:"title"`
		Type  string `json:"type"`
		URL   string `json:"url"`
	}
	if json.Unmarshal(body, &raw) != nil || len(raw) > maxBrowserTargets {
		return browserObservation{}, errInvalidFrame
	}
	targets := make([]browserTarget, 0, len(raw))
	for _, target := range raw {
		if target.Type != "page" || len(target.Title) > 512 {
			return browserObservation{}, errInvalidFrame
		}
		url, ok := safeObservedBrowserURL(target.URL)
		if !ok {
			return browserObservation{}, errInvalidFrame
		}
		targets = append(targets, browserTarget{Title: target.Title, Type: target.Type, URL: url})
	}
	return browserObservation{Targets: targets}, nil
}

func dialBrowserDevTools(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" || address != browserDevToolsAddress {
		return nil, errors.New("unexpected browser observer destination")
	}
	return (&net.Dialer{}).DialContext(ctx, network, address)
}

func safeObservedBrowserURL(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.Port() != "" || parsed.User != nil {
		return "", false
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	value := parsed.String()
	return value, len(value) <= maxBrowserURLBytes
}
