cmake_minimum_required(VERSION 3.12)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

project(mgs VERSION 1.0)

# find source files:
# -----------------
set(mgs_src
	"src/mgs_gaussian.cpp"
	"src/mgs_ply.cpp"
	"src/mgs_emscripten_bindings.cpp"
)

# create executable:
# -----------------
add_executable(${PROJECT_NAME} ${mgs_src})

# set emscripten flags:
# -----------------
set_target_properties(${PROJECT_NAME} PROPERTIES COMPILE_FLAGS 
	"-O3          \
	-flto         \
	-msimd128     \
	-msse2        \
	-msse3        \
	-pthread      \
	-fexceptions"
)
set_target_properties(${PROJECT_NAME} PROPERTIES LINK_FLAGS 
	"-s ENVIRONMENT=web,worker     \
	 -s SINGLE_FILE=1              \
	 -s MODULARIZE=1               \
	 -s EXPORT_ES6=1               \
	 -s EXPORT_NAME=MGS            \
	 -s ALLOW_MEMORY_GROWTH        \
	 -s SHARED_MEMORY=1            \
	 -s PTHREAD_POOL_SIZE=4        \
	 -s PTHREAD_POOL_SIZE_STRICT=2 \
	 -O3                           \
	 -pthread                      \
	 -flto                         \
	 -fexceptions                  \
	 --bind"
)

# add include dirs + libraries:
# -----------------
include_directories(
	"${CMAKE_CURRENT_SOURCE_DIR}/include" 
	"${CMAKE_CURRENT_SOURCE_DIR}/external/QuickMathHPP" 
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