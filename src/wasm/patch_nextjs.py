# see: https://github.com/emscripten-core/emscripten/issues/19996
# for why this is necessary

# really, we shouldn't use emscripten pthreads at all,
# we should rework this to use a custom Worker + SharedArrayBuffer solution

import sys

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Broken usage: patch_nextjs.py <CMake Output>")
        sys.exit(1)

    with open(sys.argv[1], "r") as file:
        contents = file.read()

    if "var window" in contents:
        sys.exit(0)

    contents = contents.replace(
        "var moduleRtn;",
        "var window = {\n"                              \
        "    encodeURIComponent: encodeURIComponent,\n" \
        "    location: location\n"                      \
        "};\n"                                          \
        "var moduleRtn;"
    )

    with open(sys.argv[1], "w") as file:
        file.write(contents)