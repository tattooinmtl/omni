---
name: vs-project-starter
command: /new-project
description: Interactive guide to create the right Visual Studio 2026 project from scratch, step by step.
---

# Visual Studio 2026 Project Starter

## Purpose
Guide the user through an interactive questionnaire to determine the best Visual Studio 2026 project type, then create and configure the project step by step.

## When to use
Use this skill when the user runs:

/new-project

## Phase 1 — Discovery Questions

Ask the user the following questions ONE AT A TIME (wait for each answer before asking the next). Keep a running summary of their answers.

### Q1 — Purpose
**What is the application for? What problem does it solve or what does it do?**
→ This determines the broad category (web, desktop, mobile, service, library, game, data, etc.)

### Q2 — Users & Platform
**Who will use it and on what device/platform?**
Examples: internal team on Windows PCs, public users on phones, browser-based, cross-platform, etc.
→ This narrows the UI technology and target framework.

### Q3 — Data & Backend
**Does the app need to store data, call APIs, or run a backend service?**
→ This determines if we need a database, API layer, or backend project.

### Q4 — Scale & Complexity
**What scale are you targeting?**
Options: prototype/MVP, small personal tool, medium business app, large enterprise system
→ This influences architecture decisions (monolith vs layered vs microservices).

### Q5 — Tech Preferences
**Do you have any technology preferences or constraints?**
Examples: must use C#, prefer F#, need .NET 9, must support Linux, company uses React, etc.
→ This locks in language and framework choices.

### Q6 — Team & Experience
**What's your team's experience level and size?**
Options: solo beginner, solo experienced, small team, large team
→ This affects project structure complexity and boilerplate amount.

## Phase 2 — Recommendation

After collecting all answers, present a clear recommendation with:

1. **Project Type** — The exact Visual Studio 2026 project template to use
2. **Language** — Recommended programming language
3. **Framework** — Target framework (e.g., .NET 9, .NET Framework 4.8)
4. **Architecture** — Suggested project structure (monolith, layered, clean architecture, etc.)
5. **Key NuGet Packages** — Essential packages to install upfront
6. **Why this choice** — 2-3 sentence justification linking back to the user's answers

Present this as a formatted recommendation block. Ask the user to confirm or adjust before proceeding.

## Phase 3 — Project Creation (Step by Step)

Once the user confirms the recommendation, execute the following steps ONE AT A TIME, explaining each before running it:

### Step 1 — Create the solution
Use `dotnet` CLI commands to scaffold the solution and projects. Example patterns:

```
dotnet new sln -n <SolutionName>
dotnet new <template> -n <ProjectName> -o <ProjectName> -f <framework>
dotnet sln add <ProjectName>
```

Common templates for Visual Studio 2026:
- `console` — Console Application
- `webapp` — ASP.NET Core Web App (Razor Pages)
- `web` — ASP.NET Core Web App (MVC)
- `webapi` — ASP.NET Core Web API
- `blazor` — Blazor Server
- `blazorwasm` — Blazor WebAssembly
- `winforms` — Windows Forms
- `wpf` — WPF Application
- `maui` — .NET MAUI (cross-platform)
- `classlib` — Class Library
- `worker` — Worker Service / Background Service
- `grpc` — gRPC Service
- `xunit` / `nunit` / `mstest` — Test projects

### Step 2 — Add additional projects
If the architecture calls for multiple projects (e.g., separate class library for business logic, test project, etc.), create each one and add to the solution.

### Step 3 — Add project references
Wire up project-to-project references:
```
dotnet add <ProjectName> reference <OtherProjectName>
```

### Step 4 — Install NuGet packages
Install the recommended packages:
```
dotnet add <ProjectName> package <PackageName>
```

### Step 5 — Create folder structure
Create the recommended folder structure inside each project using `make_dir`. Common patterns:

**Clean Architecture pattern:**
- `Domain/Entities`
- `Domain/Interfaces`
- `Application/Services`
- `Application/DTOs`
- `Infrastructure/Data`
- `Infrastructure/Services`
- `Presentation/Controllers` (or Pages/ViewModels)
- `Presentation/Middleware`

**Simple layered pattern:**
- `Models`
- `Services`
- `Repositories`
- `Controllers` (or ViewModels)
- `Views` (if applicable)

### Step 6 — Add starter files
Create essential boilerplate files:
- `Program.cs` modifications (DI registration, middleware pipeline)
- `appsettings.json` with basic configuration
- `.gitignore` for the project type
- A basic `README.md` with project description and run instructions

### Step 7 — Build and verify
Run `dotnet build` to verify everything compiles. Fix any errors before continuing.

### Step 8 — Initial commit (if git is available)
```
git init
git add .
git commit -m "Initial project scaffold"
```

## Phase 4 — Next Steps

After the project is created and verified, present:

1. **How to open** — `start <SolutionName>.sln` to open in Visual Studio 2026
2. **How to run** — `dotnet run --project <ProjectName>` or F5 in VS
3. **Suggested development order** — What to build first based on the app's purpose
4. **Useful VS extensions** — Recommend relevant extensions (e.g., EF Core Power Tools, ReSharper, etc.)
5. **Offer to continue** — Ask if the user wants to scaffold the first feature

## Rules
- Always ask questions one at a time. Never dump all questions at once.
- Adapt recommendations to the user's answers — do not default to a one-size-fits-all template.
- Prefer the latest stable framework version (.NET 9) unless the user needs compatibility.
- Use `dotnet` CLI commands via `run_shell` for all project creation — this works with Visual Studio 2026.
- After each CLI step, verify it succeeded before moving to the next.
- If a command fails, read the error, explain it to the user, and retry with a fix.
- Keep the project structure appropriate to the user's experience level — don't over-engineer for a beginner.
- For Windows-specific project types (WinForms, WPF), confirm the user is on Windows before suggesting them.
- Always create a test project alongside the main project when the scale is "medium" or above.

## Output
1. Interactive Q&A (one question at a time)
2. Formatted recommendation with justification
3. Step-by-step project creation with live CLI output
4. Build verification
5. "How to open and run" summary
6. Suggested next development steps
