from datetime import datetime, timezone
import time

try:
    while True:
        now = datetime.now(timezone.utc)
        print(f"\r{now.strftime('%Y-%m-%d %H:%M')} UTC", end="", flush=True)
        time.sleep(60 - now.second)
except KeyboardInterrupt:
    print()
