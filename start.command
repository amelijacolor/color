#!/bin/bash
# Double-click this file to start your website preview + private admin panel.
cd "$(dirname "$0")"
python3 serve.py 8090 &
SITE_PID=$!
python3 admin/admin.py 8091 &
ADMIN_PID=$!
sleep 1
open "http://127.0.0.1:8091"
echo ""
echo "  Website preview : http://127.0.0.1:8090"
echo "  Admin panel     : http://127.0.0.1:8091   (private, only on this computer)"
echo ""
echo "  Close this window (or press Ctrl+C) to stop both."
trap "kill $SITE_PID $ADMIN_PID 2>/dev/null" EXIT
wait
