set -x
mkdir backup
cp vocab.db* backup
git checkout vocab.db*
git add -u .
