cmake_minimum_required(VERSION 3.22.1)
project(local_tavern LANGUAGES CXX)

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
