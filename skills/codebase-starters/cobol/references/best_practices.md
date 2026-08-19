# COBOL Engineering Reference & Deep Best Practices

## 1. Enterprise VSAM File Status Codes
- `00`: Successful completion.
- `02`: Duplicate key detected (non-fatal warning).
- `10`: End of file (EOF) reached.
- `23`: Record not found.

## 2. Computational Storage Formats
- `DISPLAY`: Standard ASCII/EBCDIC text (1 byte per digit).
- `COMP` / `BINARY`: Binary integers (2, 4, or 8 bytes).
- `COMP-3`: Packed Decimal (2 digits per byte + sign nibble). Essential for mainframe banking/accounting.
