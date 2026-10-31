cmake_minimum_required(VERSION 3.22.1)
project(local_tavern LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(NODE_SDK "${CMAKE_CURRENT_SOURCE_DIR}/../../../libnode")
set(NODE_LIBRARY "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")

if(NOT EXISTS "${NODE_LIBRARY}" OR NOT EXISTS "${NODE_SDK}/include/node/node.h")
    message(FATAL_ERROR "Node mobile SDK missing. Run: python3 scripts/prepare_runtime.py")
endif()

add_library(local_tavern SHARED node_bridge.cpp)
target_include_directories(local_tavern SYSTEM PRIVATE "${NODE_SDK}/include/node")
target_compile_options(local_tavern PRIVATE -Wall -Wextra -Werror -fvisibility=hidden)
# Link by filename rather than declaring an IMPORTED shared-library target:
# AGP already packages libnode.so from jniLibs and must not package it twice.
target_link_libraries(local_tavern PRIVATE "${NODE_LIBRARY}" log)
target_link_options(local_tavern PRIVATE "-Wl,-z,max-page-size=16384" "-Wl,-z,common-page-size=16384")

# The installer must not load Node/V8 just to decompress the bundled files.
# This C-only target has no libnode or libc++ dependency.
set(ZSTD_SDK "${CMAKE_CURRENT_SOURCE_DIR}/../../../libzstd")
if(NOT EXISTS "${ZSTD_SDK}/lib/zstd.h" OR NOT EXISTS "${ZSTD_SDK}/codec.json")
    message(FATAL_ERROR "Zstandard codec missing. Run: python3 scripts/prepare_codec.py")
endif()
file(GLOB ZSTD_COMMON CONFIGURE_DEPENDS "${ZSTD_SDK}/lib/common/*.c")
file(GLOB ZSTD_DECOMPRESS CONFIGURE_DEPENDS "${ZSTD_SDK}/lib/decompress/*.c")
add_library(tavern_bundle SHARED bundle_zstd.c ${ZSTD_COMMON} ${ZSTD_DECOMPRESS})
target_include_directories(tavern_bundle PRIVATE "${ZSTD_SDK}/lib")
target_compile_definitions(tavern_bundle PRIVATE ZSTD_DISABLE_ASM ZSTD_LEGACY_SUPPORT=0
    ZSTDLIB_VISIBLE= ZSTDERRORLIB_VISIBLE=)
target_compile_options(tavern_bundle PRIVATE -Os -fvisibility=hidden -ffunction-sections -fdata-sections)
target_link_options(tavern_bundle PRIVATE "-Wl,--gc-sections" "-Wl,-z,max-page-size=16384" "-Wl,-z,common-page-size=16384")
