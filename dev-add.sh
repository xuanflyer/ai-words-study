set -x
mkdir backup
cp vocab.db vocab.db-shm vocab.db-wal  backup
git checkout vocab.db vocab.db-shm vocab.db-wal
git add -u .
git status
