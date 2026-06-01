import os
from collections import Counter

root = r'C:\Users\yangx\Desktop\SoloForge'
ext_counter = Counter()
dir_counter = Counter()
total_files = 0
total_dirs = 0

for dirpath, dirnames, filenames in os.walk(root):
    # Skip node_modules and .git directories
    if 'node_modules' in dirpath or '.git' in dirpath:
        continue
    total_dirs += len(dirnames)
    for f in filenames:
        total_files += 1
        ext = os.path.splitext(f)[1].lower()
        if ext:
            ext_counter[ext] += 1
        else:
            ext_counter['(no extension)'] += 1

print(f'Total files: {total_files}')
print(f'Total directories: {total_dirs}')
print('\nTop 20 file extensions:')
for ext, count in ext_counter.most_common(20):
    print(f'{ext}: {count}')

print('\nDirectory structure (top level):')
for item in os.listdir(root):
    item_path = os.path.join(root, item)
    if os.path.isdir(item_path):
        if item not in ['node_modules', '.git', '.tmp.driveupload', '.pytest_cache']:
            print(f'  [DIR] {item}')
    else:
        print(f'  [FILE] {item}')
