cmake_minimum_required(VERSION 3.12)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

project(dgs VERSION 1.0)

# find source files:
# -----------------
set(dgs_src
	"ext.cpp"

	"DGS/csrc/src/dgs_error.c"
	"DGS/csrc/src/dgs_gaussians.c"
	"DGS/csrc/src/dgs_encode.c"
	"DGS/csrc/src/dgs_decode.c"
)

# create executable:
# -----------------
add_executable(${PROJECT_NAME} ${dgs_src})

include_directories(${PROJECT_NAME}
	"DGS/csrc/include"
	"DGS/csrc/external"
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
	 -s EXPORT_NAME=DGS     \
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
		"${CMAKE_SOURCE_DIR}/dgs.js"
	COMMENT "Copying dgs.js to ${CMAKE_SOURCE_DIR}"
)