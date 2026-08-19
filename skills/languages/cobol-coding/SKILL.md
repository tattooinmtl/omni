---
name: cobol-coding
command: /cobol
description: COBOL environment setup, syntax rules, best practices, and project scaffolding.
---

# COBOL Coding Skill

## Purpose
Guide the user through COBOL environment detection, installation, project scaffolding, COBOL syntax, coding standards, and best practices for enterprise applications.

## When to use
Use this skill when the user runs:

/cobol [subcommand]

Subcommands:
- (none) — Detect COBOL environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new COBOL project
- check — Scan current project for issues
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing COBOL installation
Use `run_shell` to check:
```powershell
where cobc
cobc --version
```

Also check for C compiler (GnuCOBOL requires one):
```powershell
where gcc
where cl
```

### Step 2: Report status
- ✅ / ❌ GnuCOBOL compiler (cobc)
- ✅ / ❌ C compiler (gcc or MSVC — required by GnuCOBOL)

### Step 3: Install GnuCOBOL if missing

**Windows:**
```powershell
# Option A: Download pre-built Windows binaries
# From https://sourceforge.net/projects/open-cobol/
# Extract to C:\GnuCOBOL
# Add C:\GnuCOBOL\bin to PATH

# Option B: Use WSL2 (recommended for full compatibility)
wsl --install
# Inside WSL:
sudo apt update
sudo apt install gnucobol

# Option C: Build from source with MinGW
# See Arnold Trembley's build guide:
# https://www.arnoldtrembley.com/GnuCOBOL.htm
```

**Linux:**
```bash
# Ubuntu/Debian
sudo apt install gnucobol

# Fedora/RHEL
sudo dnf install gnucobol

# Build from source
wget https://sourceforge.net/projects/gnucobol/files/latest
tar xzf gnucobol-3.2.tar.gz
cd gnucobol-3.2
./configure --prefix=/usr/local
make
sudo make install
```

**macOS:**
```bash
brew install gnucobol
```

### Step 4: Verify
```powershell
cobc --version
# Test compilation:
echo 'IDENTIFICATION DIVISION.' > test.cob
echo 'PROGRAM-ID. TEST.' >> test.cob
echo 'PROCEDURE DIVISION.' >> test.cob
echo 'DISPLAY "Hello COBOL!".' >> test.cob
echo 'STOP RUN.' >> test.cob
cobc -x test.cob
./test
```

---

## Phase 2 — Project Scaffolding

### COBOL project structure
```
my_cobol_project/
├── src/
│   ├── main.cob           # Main program
│   ├── subprog1.cob       # Subprograms
│   └── subprog2.cob
├── copybooks/             # Shared copybooks
│   ├── customer-rec.cpy
│   └── file-status.cpy
├── data/                  # Data files
├── tests/
│   └── test_main.cob
├── Makefile               # Build configuration
└── README.md
```

### Makefile for COBOL
```makefile
COBC = cobc
COBCFLAGS = -x -free
COPYBOOK_DIR = copybooks

SRCS = $(wildcard src/*.cob)
BINS = $(patsubst src/%.cob,%,$(SRCS))

all: $(BINS)

%: src/%.cob
	$(COBC) $(COBCFLAGS) -I$(COPYBOOK_DIR) $< -o $@

clean:
	rm -f $(BINS)

test: all
	./main

.PHONY: all clean test
```

---

## Phase 3 — Syntax Rules & Best Practices

### Program Structure (Four Divisions)
Every COBOL program must have these divisions in order:
1. **IDENTIFICATION DIVISION** — program identity
2. **ENVIRONMENT DIVISION** — hardware/file environment
3. **DATA DIVISION** — data definitions
4. **PROCEDURE DIVISION** — executable code

```cobol
       IDENTIFICATION DIVISION.
       PROGRAM-ID. EXAMPLE-PROGRAM.
      *AUTHOR. Your Name
      *DATE-WRITTEN. 2026-01-15
      *PURPOSE. Process customer transactions

       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT CUSTOMER-FILE
               ASSIGN TO "customer.dat"
               ORGANIZATION IS INDEXED
               ACCESS MODE IS RANDOM
               RECORD KEY IS CUSTOMER-ID
               FILE STATUS IS WS-FILE-STATUS.

       DATA DIVISION.
       FILE SECTION.
       FD CUSTOMER-FILE.
       01 CUSTOMER-RECORD.
           05 CUSTOMER-ID        PIC X(10).
           05 CUSTOMER-NAME      PIC X(50).
           05 CUSTOMER-BALANCE   PIC S9(8)V99.

       WORKING-STORAGE SECTION.
       01 WS-FILE-STATUS         PIC X(2) VALUE SPACES.
       01 WS-END-OF-FILE         PIC X(1) VALUE 'N'.
           88 EOF                VALUE 'Y'.
           88 NOT-EOF            VALUE 'N'.

       PROCEDURE DIVISION.
       MAIN-LOGIC.
           PERFORM 1000-INITIALIZE
           PERFORM 2000-PROCESS-DATA
           PERFORM 3000-FINALIZE
           STOP RUN.

       1000-INITIALIZE.
           OPEN INPUT CUSTOMER-FILE
           IF WS-FILE-STATUS NOT = "00"
               DISPLAY "ERROR: Cannot open file"
               STOP RUN
           END-IF.

       2000-PROCESS-DATA.
           PERFORM UNTIL EOF
               READ CUSTOMER-FILE
                   AT END
                       SET EOF TO TRUE
                   NOT AT END
                       PERFORM 2100-PROCESS-RECORD
               END-READ
           END-PERFORM.

       2100-PROCESS-RECORD.
           DISPLAY "Customer: " CUSTOMER-ID " " CUSTOMER-NAME.

       3000-FINALIZE.
           CLOSE CUSTOMER-FILE
           DISPLAY "Processing complete".
```

### Naming Conventions
- **Program names**: `UPPER-CASE` with hyphens (e.g., `CUSTOMER-PROCESSING`)
- **Data items**: Prefix with level + descriptive name (e.g., `WS-CUSTOMER-NAME`)
- **Paragraphs**: Numbered with descriptive names (e.g., `1000-INITIALIZE`)
- **File names**: Descriptive with hyphens (e.g., `CUSTOMER-MASTER-FILE`)
- **88-levels**: Descriptive condition names (e.g., `EOF`, `NOT-EOF`)

### Variable Prefixes
- `WS-` — Working-Storage
- `LS-` — Local-Storage
- `LINK-` — Linkage Section
- `FD-` — File Description

### Level Numbers
- **01** — Record or group item
- **05, 10, 15...** — Subordinate items (indent by 5)
- **88** — Condition names (for flags/enums)
- **77** — Standalone elementary items (avoid in modern code)

```cobol
01 WS-CUSTOMER-DATA.
   05 WS-CUSTOMER-ID          PIC X(10).
   05 WS-CUSTOMER-NAME        PIC X(50).
   05 WS-CUSTOMER-DETAILS.
      10 WS-CUSTOMER-ADDRESS  PIC X(100).
      10 WS-CUSTOMER-PHONE    PIC X(15).
   05 WS-CUSTOMER-STATUS      PIC X(1).
      88 WS-ACTIVE            VALUE 'A'.
      88 WS-INACTIVE          VALUE 'I'.
      88 WS-SUSPENDED         VALUE 'S'.
```

### USAGE Clauses (Performance)
- **`USAGE COMP` / `USAGE BINARY`** — binary storage (fastest for arithmetic)
- **`USAGE COMP-3`** — packed decimal (for financial calculations)
- **`USAGE COMP-5`** — native binary (fastest for integers)
- **`USAGE DISPLAY`** — display format (default, slowest for arithmetic)
- **Use COMP-3 for decimal arithmetic** — financial applications
- **Use COMP-5 for integer arithmetic** — counters, indices

```cobol
01 WS-FINANCIAL-DATA.
   05 WS-BALANCE      PIC S9(8)V99 USAGE COMP-3.  * Packed decimal
   05 WS-COUNTER      PIC S9(6)    USAGE COMP-5.  * Native binary
   05 WS-DISPLAY-VAL  PIC S9(8)V99 USAGE DISPLAY.  * Display only
```

### Structured Programming
- **Use PERFORM for modular code** — not GO TO (avoid GO TO entirely)
- **Use numbered paragraphs** — 1000-INITIALIZE, 2000-PROCESS, 3000-FINALIZE
- **Use END-VERB constructs** — END-IF, END-READ, END-PERFORM
- **Use 88-level conditions** — not magic values
- **Use EVALUATE** instead of nested IFs — like a switch/case

```cobol
* EVALUATE (switch/case equivalent)
EVALUATE WS-CUSTOMER-STATUS
    WHEN 'A'
        PERFORM 2100-PROCESS-ACTIVE
    WHEN 'I'
        PERFORM 2200-PROCESS-INACTIVE
    WHEN 'S'
        PERFORM 2300-PROCESS-SUSPENDED
    WHEN OTHER
        PERFORM 2400-PROCESS-UNKNOWN
END-EVALUATE.

* 88-level conditions (not magic values)
IF WS-ACTIVE
    PERFORM 2100-PROCESS-ACTIVE
END-IF
```

### File Handling
- **Always check FILE STATUS** after every file operation
- **Use AT END / NOT AT END** for READ operations
- **Use INVALID KEY / NOT INVALID KEY** for indexed file operations
- **Always CLOSE files** before program termination

```cobol
* File status values:
* "00" = Success
* "10" = End of file
* "23" = Record not found
* "35" = File not found
* "30" = Other error

READ CUSTOMER-FILE
    AT END
        SET EOF TO TRUE
    NOT AT END
        PERFORM 2100-PROCESS-RECORD
END-READ

* Always check file status
IF WS-FILE-STATUS NOT = "00" AND NOT = "10"
    DISPLAY "ERROR: File operation failed: " WS-FILE-STATUS
    PERFORM 9000-ERROR-HANDLER
END-IF
```

### Error Handling
- **Check FILE STATUS after every file operation**
- **Use a centralized error-handling paragraph**
- **Log errors with context** — program name, paragraph, error code
- **Set maximum error count** — stop processing after threshold
- **Use DISPLAY for error messages** — include file status and record info

```cobol
01 WS-ERROR-CONTROL.
   05 WS-ERROR-COUNT     PIC 9(4) VALUE ZERO.
   05 WS-MAX-ERRORS      PIC 9(4) VALUE 10.
   05 WS-CONTINUE-FLAG   PIC X(1) VALUE 'Y'.
      88 WS-STOP         VALUE 'N'.
      88 WS-CONTINUE     VALUE 'Y'.

9000-ERROR-HANDLER.
    ADD 1 TO WS-ERROR-COUNT
    DISPLAY "ERROR #" WS-ERROR-COUNT
    IF WS-ERROR-COUNT >= WS-MAX-ERRORS
        DISPLAY "Maximum errors reached - stopping"
        SET WS-STOP TO TRUE
    END-IF.
```

### Documentation Standards
- **Always include AUTHOR, DATE-WRITTEN, PURPOSE in IDENTIFICATION DIVISION**
- **Use comment lines (column 7 with `*`)** for section documentation
- **Document input/output files** at the top of the program
- **Document processing logic** with numbered steps
- **Document maintenance history** — date and description of changes

```cobol
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CUSTOMER-PROCESSING.
      *AUTHOR. Development Team
      *DATE-WRITTEN. 2026-01-15
      *DATE-MODIFIED. 2026-02-20
      *PURPOSE. Process customer transactions
      *NOTES. Validates and processes customer data
      *
      *INPUT FILES:
      *  CUSTOMER.DAT - Customer master file
      *  TRANS.DAT - Transaction file
      *
      *OUTPUT FILES:
      *  UPDATED.DAT - Updated customer file
      *  ERROR.LOG - Error log file
      *
      *MAINTENANCE:
      *  2026-02-20 - Added new transaction types
      *  2026-01-15 - Initial version
```

### Table Handling (Arrays)
- **Use OCCURS** for arrays
- **Use INDEXED BY** for performance
- **Use SEARCH for linear search**, SEARCH ALL for binary search

```cobol
01 WS-PRODUCT-TABLE.
   05 WS-PRODUCT-ENTRY OCCURS 100 TIMES
       INDEXED BY WS-PRODUCT-INDEX.
      10 WS-PRODUCT-ID    PIC X(10).
      10 WS-PRODUCT-NAME  PIC X(30).
      10 WS-PRODUCT-PRICE PIC S9(5)V99 USAGE COMP-3.

* Linear search
SET WS-PRODUCT-INDEX TO 1
SEARCH WS-PRODUCT-ENTRY
    AT END
        DISPLAY "Product not found"
    WHEN WS-PRODUCT-ID(WS-PRODUCT-INDEX) = WS-SEARCH-ID
        DISPLAY "Found: " WS-PRODUCT-NAME(WS-PRODUCT-INDEX)
END-SEARCH

* Binary search (table must be sorted)
SEARCH ALL WS-PRODUCT-ENTRY
    AT END
        DISPLAY "Product not found"
    WHEN WS-PRODUCT-ID(WS-PRODUCT-INDEX) = WS-SEARCH-ID
        DISPLAY "Found: " WS-PRODUCT-NAME(WS-PRODUCT-INDEX)
END-SEARCH
```

### Copybooks
- **Use COPY for shared data definitions** — DRY principle
- **Store copybooks in a shared directory**
- **Use meaningful copybook names**

```cobol
* copybooks/customer-rec.cpy
       01 CUSTOMER-RECORD.
           05 CUSTOMER-ID        PIC X(10).
           05 CUSTOMER-NAME      PIC X(50).
           05 CUSTOMER-BALANCE   PIC S9(8)V99 USAGE COMP-3.

* In main program:
       COPY "customer-rec.cpy".
```

### Free vs Fixed Format
- **Fixed format**: Columns 1-6 sequence, 7 indicator, 8-72 code (traditional)
- **Free format**: No column restrictions (modern, recommended for new code)
- **Use `-free` compiler flag** for free format

```powershell
cobc -x -free program.cob
```

---

## Phase 4 — Verification & Build

### Compile
```powershell
cobc -x -free -I copybooks/ src/main.cob -o main
cobc -x -free -I copybooks/ src/subprog1.cob -o subprog1
```

### Compile with debugging
```powershell
cobc -x -free -g -debug src/main.cob -o main
```

### Run
```powershell
./main
```

### Syntax check only
```powershell
cobc -free -fsyntax-only src/main.cob
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| Four divisions in order | COBOL standard structure |
| Numbered paragraphs (1000-INIT) | Clear execution flow |
| 88-level conditions | Eliminate magic values |
| USAGE COMP-3 for decimals | Financial arithmetic performance |
| USAGE COMP-5 for integers | Counter/index performance |
| EVALUATE over nested IFs | Readable, maintainable |
| END-VERB constructs | Clear scope boundaries |
| FILE STATUS checking | Robust error handling |
| Copybooks for shared data | DRY, maintainable |
| Avoid GO TO | Structured programming |
| Document thoroughly | Programs outlive authors |
| Free format for new code | Modern, readable |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Always use the four divisions in order: IDENTIFICATION, ENVIRONMENT, DATA, PROCEDURE.
- Never use GO TO — use PERFORM for modular code.
- Always check FILE STATUS after file operations.
- Use 88-level conditions instead of magic values.
- Use USAGE COMP-3 for financial calculations, COMP-5 for integers.
- Use EVALUATE instead of nested IFs.
- Document thoroughly — COBOL programs outlive their authors.
- Use END-VERB constructs (END-IF, END-READ, END-PERFORM) for clarity.
- Use free format (`-free` flag) for new code.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Project scaffold (if requested)
4. Code with COBOL best practices applied
5. Compilation and run verification