# 本机 git 代理配置

## 症状

`git push` / `git ls-remote` 报：

```
fatal: unable to access 'https://github.com/...':
Failed to connect to github.com port 443 after 21089 ms
```

但同一个终端里 `Invoke-WebRequest https://github.com` 返回 200。

## 根因

Windows 的系统代理开在 `127.0.0.1:7890`：

```
HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings
  ProxyEnable = 1
  ProxyServer = 127.0.0.1:7890
```

PowerShell 的 `Invoke-WebRequest` 走 `.NET` 的默认代理，所以能通。
`git`（内置 libcurl）和 `curl.exe` 不读注册表，环境里也没有
`HTTPS_PROXY`，于是直连 github.com:443，被墙。

## 修复

只给这个仓库配代理，不改全局配置：

```powershell
cd C:\Users\13420\Documents\ChatGPT\agents
git config --local http.proxy  'http://127.0.0.1:7890'
git config --local https.proxy 'http://127.0.0.1:7890'
```

验证：

```powershell
git ls-remote --heads origin
```

## 为什么不用全局配置

`git config --global http.proxy` 会影响这台机器上所有仓库，包括那些
走内网或本来就不需要代理的。仓库级配置只影响这一个。

如果代理端口变了，改这两行即可；如果代理关了，执行：

```powershell
git config --local --unset http.proxy
git config --local --unset https.proxy
```

## 注意

`.git/config` 不进版本库，所以这个配置不会被提交，也不会泄漏到别处。
