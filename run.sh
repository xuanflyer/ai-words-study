#npm start
lsof -i :3000 | awk '{print $2}' | grep -v PID | xargs -i kill {}
#npm ci
HOST=0.0.0.0 npm start

