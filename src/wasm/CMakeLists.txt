cmake_minimum_required(VERSION 3.12)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

project(mgs VERSION 1.0)

# find source files:
# -----------------
set(mgs_src
	"ext.cpp"

	"MGS/csrc/src/mgs_error.c"
	"MGS/csrc/src/mgs_gaussians.c"
	"MGS/csrc/src/mgs_encode.c"
	"MGS/csrc/src/mgs_decode.c"
)

# create executable:
# -----------------
add_executable(${PROJECT_NAME} ${mgs_src})

include_directories(${PROJECT_NAME}
	"MGS/csrc/include"
	"MGS/csrc/external"
)

# set emscripten flags:
# -----------------
set_target_properties(${PROJECT_NAME} PROPERTIES COMPILE_FLAGS 
	"-O3          \
	-flto         \
	-msimd128     \
	-msse2        \
	-msse3        \
	-fexceptions"
)
set_target_properties(${PROJECT_NAME} PROPERTIES LINK_FLAGS 
	"-s ENVIRONMENT=web     \
	 -s SINGLE_FILE=1       \
	 -s MODULARIZE=1        \
	 -s EXPORT_ES6=1        \
	 -s EXPORT_NAME=MGS     \
	 -s ALLOW_MEMORY_GROWTH \
	 -O3                    \
	 -flto                  \
	 -fexceptions           \
	 --bind"
)

# add include dirs + libraries:
# -----------------
include_directories(
	"${CMAKE_CURRENT_SOURCE_DIR}/MGS/csrc/include" 
)
target_link_libraries(${PROJECT_NAME})

# copy up to wasm/ directory:
# -----------------
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
	COMMAND ${CMAKE_COMMAND} -E copy
		"$<TARGET_FILE_DIR:${PROJECT_NAME}>/${PROJECT_NAME}.js"
		"${CMAKE_SOURCE_DIR}/mgs.js"
	COMMENT "Copying mgs.js to ${CMAKE_SOURCE_DIR}"
)