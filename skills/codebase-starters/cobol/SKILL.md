---
name: cobol
description: >-
  Enterprise COBOL 2014/2023 codebase starter, GnuCOBOL (cobc), Fixed/Free format standards, Division structuring, Copybooks, File I/O (Indexed/VSAM), and harness verification.
---

# COBOL Codebase & Enterprise Engineering Skill

Operational guide, architecture starter, best practices, and harness controls for COBOL enterprise mainframe and modern GnuCOBOL systems.

## 1. Stack Overview & Dependencies
- **Compilers**: `GnuCOBOL` (`cobc`), IBM Enterprise COBOL for z/OS, Micro Focus COBOL
- **Dialects**: COBOL 85, COBOL 2002, COBOL 2014, COBOL 2023
- **File Systems & Databases**: VSAM (KSDS/ESDS/RRDS), DB2 SQL (`EXEC SQL`), Sequential / Line Sequential files
- **Tooling**: `cobcrun`, `gnucobol-debug`, copybook preprocessors

## 2. Standard Codebase Structure
```text
cobol-system/
├── README.md
├── src/
│   ├── PROCESS_RECORDS.cbl
│   └── HELLO.cbl
├── copybooks/
│   └── CPYUSER.cpy
└── tests/
    └── test_process.sh
```

## 3. How-To Workflows

### Compile COBOL Program with GnuCOBOL
```bash
# Compile to executable
cobc -x -o bin/process_records src/PROCESS_RECORDS.cbl

# Compile with free source format (-free) and debug flags (-g)
cobc -x -free -g -o bin/hello src/HELLO.cbl
```

### Run Compiled Executable
```bash
./bin/process_records
```

### Compile Module to Dynamic Library (`.so` / `.dll`)
```bash
cobc -m src/PROCESS_RECORDS.cbl
```

## 4. Best Practices & Design Patterns
1. **Four Mandatory Divisions**: Maintain crisp layout of `IDENTIFICATION DIVISION`, `ENVIRONMENT DIVISION`, `DATA DIVISION`, and `PROCEDURE DIVISION`.
2. **Copybook Modularization**: Use `COPY "CPYUSER.cpy".` for shared data structure definitions instead of repeating `01` level record layouts.
3. **Picture (PIC) Clause Precision**: Define exact data storage lengths (`PIC X(30)` for strings, `PIC 9(05)V99` for decimal currency fields, `COMP-3` for packed decimal financial calculations).
4. **Structured Flow Control**: Use `EVALUATE ... WHEN ... END-EVALUATE` instead of deeply nested `IF` statements. Use `PERFORM` paragraphs with `UNTIL` conditions rather than `GO TO`.
5. **File Handling Verification**: Always verify `FILE STATUS` codes (`00` = Success) immediately after `OPEN`, `READ`, `WRITE`, or `CLOSE` operations.

## 5. Tips, Tricks & Pitfalls
- **Fixed Format Column Alignment**: In standard fixed format, Columns 1-6 are for sequence numbers, Column 7 is Indicator (e.g. `*` for comment, `-` for continuation), Columns 8-11 are Area A, and Columns 12-72 are Area B.
- **Packed Decimal (`COMP-3`)**: Use `COMP-3` (computational-3) for financial numbers to save 50% memory and eliminate floating-point rounding errors.
- **Paragraph Scoping**: Scope paragraphs cleanly and end procedures with `EXIT` or explicit `END-PERFORM` / `END-IF`.

## 6. Harness Hooks & Safety Enforcement
- **PreToolUse Guard**: Run `cobc -fsyntax-only` to validate COBOL syntax before building.
- **PostToolUse Verification**: Audit return status code (`RETURN-CODE = 0`) on test run completions.
