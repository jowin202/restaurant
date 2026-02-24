import sys
import os
import hmac
import hashlib
import base64
from dotenv import load_dotenv

load_dotenv()

def resign(file_path):
    key_hex = os.getenv('HMAC_KEY')
    if not key_hex:
        print("Fehler: HMAC_KEY nicht in .env")
        return
    
    key = bytes.fromhex(key_hex)

    # 1. Datei binär lesen, um Zeilenenden nicht zu verfälschen
    with open(file_path, 'rb') as f:
        full_data = f.read()

    # 2. Die Signatur-Zeile suchen und abschneiden
    # Wir suchen nach dem letzten Vorkommen von b"\n-- HMAC-SIG:"
    marker = b"\n-- HMAC-SIG:"
    if marker in full_data:
        # Alles VOR dem Marker ist der originale sql_content
        sql_content_bytes = full_data.rsplit(marker, 1)[0]
    else:
        # Falls keine Signatur da ist, nehmen wir alles und rstrip-en einmal
        sql_content_bytes = full_data.rstrip()

    # 3. HMAC berechnen (exakt wie im Backend)
    # Wichtig: Wir hashen die Bytes direkt
    h = hmac.new(key, sql_content_bytes, hashlib.sha256)
    signature = base64.b64encode(h.digest()).decode('utf-8')

    # 4. Datei neu schreiben (Exakt wie im Router: Inhalt + \n + Signatur)
    with open(file_path, 'wb') as f:
        f.write(sql_content_bytes)
        f.write(b"\n")
        f.write(f"-- HMAC-SIG: {signature}".encode('utf-8'))

    print(f"Neu signiert!\nSignatur: {signature}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 sign.py <file>")
    else:
        resign(sys.argv[1])