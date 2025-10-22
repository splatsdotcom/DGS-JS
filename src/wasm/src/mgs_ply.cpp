#include "mgs_ply.hpp"

#include <vector>
#include <string>
#include <string_view>
#include <unordered_map>
#include <array>
#include <cstdint>
#include <cmath>
#include <stdexcept>
#include <cstring>
#include <sstream>
#include <iostream>

namespace mgs
{

namespace ply
{

//-------------------------------------------//

/**
 * every possible data type in a .ply
 */
enum class PlyType 
{
	Int8, 
	UInt8, 
	Int16, 
	UInt16, 
	Int32, 
	UInt32, 
	Float32, 
	Float64, 
	Unknown
};

/**
 * a type + offset for a single property in a PLY
 */
struct PlyProp 
{
	PlyType type;
	uint64_t offset;
};

const std::string PLY_HEADER_START = "ply";
const std::string PLY_HEADER_END = "end_header\n";

static inline uint64_t ply_type_size(PlyType t);
static inline PlyType ply_type_parse(std::string_view name);

template<typename T> 
static inline T ply_read(PlyType type, const uint8_t* buf);

//-------------------------------------------//

GaussiansPacked load(const std::vector<uint8_t>& buf)
{
	return load(static_cast<uint64_t>(buf.size()), buf.data());
}

GaussiansPacked load(uint64_t size, const uint8_t* buf)
{
	//validate:
	//-----------------	
	if(size == 0 || !buf)
		throw std::runtime_error("Buffer is empty!");

	//parse header:
	//-----------------	
	std::string_view header(reinterpret_cast<const char*>(buf), size);
	if(header.find(PLY_HEADER_START) != 0)
		throw std::runtime_error("Invalid PLY file - mismatched header!");

	size_t headerEnd = header.find(PLY_HEADER_END);
	if(headerEnd == std::string::npos)
		throw std::runtime_error("Invalid PLY file - no header end found!");

	std::string headerStr(reinterpret_cast<const char*>(buf), headerEnd);
	std::istringstream headerStream(headerStr);

	//read properties:
	//-----------------	
	uint64_t vertexCount = 0;
	std::unordered_map<std::string, PlyProp> properties;
	uint64_t rowStride = 0;

	std::string line;
	while(std::getline(headerStream, line)) 
	{
		//TODO: look for "format"

		if(line.rfind("element vertex", 0) == 0) 
		{
			std::istringstream iss(line);
			std::string tmp; 

			iss >> tmp >> tmp >> vertexCount;
		}
		else if(line.rfind("property", 0) == 0) 
		{
			std::istringstream iss(line);
			std::string tmp, typeStr, nameStr;

			iss >> tmp >> typeStr >> nameStr;

			PlyType t = ply_type_parse(typeStr);

			uint64_t offset = rowStride;
			rowStride += ply_type_size(t);

			if(properties.find(nameStr) != properties.end())
				throw std::runtime_error("Invalid PLY file - contains duplicate properties!");

			properties.emplace(nameStr, PlyProp{t, offset});
		}
	}

	if(vertexCount == 0)
		return GaussiansPacked(Gaussians());

	//prefetch property offsets + types:
	//-----------------	
	auto findProp = [&](const std::string& name) -> const PlyProp& {
		auto it = properties.find(name);
		if(it == properties.end())
			throw std::runtime_error("PLY file missing property: " + name);

		return it->second;
	};

	struct Accessors 
	{
		const PlyProp *x, *y, *z;
		const PlyProp *scale[3];
		const PlyProp *rot[4];
		const PlyProp *color[3];
		const PlyProp *opacity;

		std::vector<std::array<const PlyProp*, 3>> rest;
	};

	Accessors acc;

	acc.x = &findProp("x");
	acc.y = &findProp("y");
	acc.z = &findProp("z");

	bool hasScale   = properties.count("scale_0") && properties.count("scale_1") && properties.count("scale_2");
	bool hasOrient  = properties.count("rot_0")   && properties.count("rot_1")   && properties.count("rot_2")   && properties.count("rot_3");
	bool hasColor   = properties.count("f_dc_0")  && properties.count("f_dc_1")  && properties.count("f_dc_2");
	bool hasOpacity = properties.count("opacity");

	if(hasScale) 
	{
		acc.scale[0] = &findProp("scale_0");
		acc.scale[1] = &findProp("scale_1");
		acc.scale[2] = &findProp("scale_2");
	}

	if(hasOrient) 
	{
		acc.rot[0] = &findProp("rot_0");
		acc.rot[1] = &findProp("rot_1");
		acc.rot[2] = &findProp("rot_2");
		acc.rot[3] = &findProp("rot_3");
	}

	if(hasColor) 
	{
		acc.color[0] = &findProp("f_dc_0");
		acc.color[1] = &findProp("f_dc_1");
		acc.color[2] = &findProp("f_dc_2");
	}

	if(hasOpacity) 
		acc.opacity = &findProp("opacity");

	//get SH properties:
	//-----------------	
	uint32_t restTriplets = 0;
	while(true) 
	{
		std::string rName = "f_rest_" + std::to_string(restTriplets * 3 + 0);
		std::string gName = "f_rest_" + std::to_string(restTriplets * 3 + 1);
		std::string bName = "f_rest_" + std::to_string(restTriplets * 3 + 2);

		if(properties.find(rName) == properties.end() ||
		   properties.find(gName) == properties.end() ||
		   properties.find(bName) == properties.end())
			break;

		acc.rest.push_back({ &findProp(rName), &findProp(gName), &findProp(bName) });
		restTriplets++;
	}

	uint32_t totalCoeffs = restTriplets + (hasColor ? 1 : 0);
	uint32_t degree = 0;
	while((degree + 1) * (degree + 1) < totalCoeffs) 
		degree++;

	if((degree + 1) * (degree + 1) != totalCoeffs)
		throw std::runtime_error("Invalid PLY file - did not contain a valid number of spherical harmonic coefficients");

	if(degree > MGS_MAX_SH_DEGREE)
	{
		degree = MGS_MAX_SH_DEGREE;
		totalCoeffs = (degree + 1) * (degree + 1);
		restTriplets = totalCoeffs - (hasColor ? 1 : 0);
		acc.rest.resize(restTriplets);
	}

	//validate data section:
	//-----------------	
	const uint8_t* dataStart = buf + headerEnd + PLY_HEADER_END.size();
	const uint8_t* dataEnd   = buf + size;
	if(dataStart + vertexCount * rowStride > dataEnd)
		throw std::runtime_error("Invalid PLY file - too small for specified data!");

	auto readProp = [&](const PlyProp* p, const uint8_t* row) -> float {
		return ply_read<float>(p->type, row + p->offset);
	};

	Gaussians gaussians(degree);

	for(uint64_t i = 0; i < vertexCount; i++) 
	{
		const uint8_t* row = dataStart + i * rowStride;

		vec3 pos = { readProp(acc.x, row), readProp(acc.y, row), readProp(acc.z, row) };
		vec3 scale(0.01f);
		quaternion rot = quaternion_identity();
		vec4 color(1.0f);

		if(hasScale) 
		{
			scale.x = std::exp(readProp(acc.scale[0], row));
			scale.y = std::exp(readProp(acc.scale[1], row));
			scale.z = std::exp(readProp(acc.scale[2], row));
		}

		if(hasOrient) 
		{
			float r0 = readProp(acc.rot[0], row);
			float r1 = readProp(acc.rot[1], row);
			float r2 = readProp(acc.rot[2], row);
			float r3 = readProp(acc.rot[3], row);

			float len = std::sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3);
			if(len > 1e-8f)
				rot = quaternion(r1 / len, r2 / len, r3 / len, r0 / len);
		}

		if(hasColor) 
		{
			color.x = readProp(acc.color[0], row);
			color.y = readProp(acc.color[1], row);
			color.z = readProp(acc.color[2], row);
		}

		if(hasOpacity)
			color.w = 1.0f / (1.0f + std::exp(-readProp(acc.opacity, row)));

		std::vector<vec3> sh(restTriplets);
		for(uint32_t j=0;j<restTriplets;j++) 
		{
			const auto& trip = acc.rest[j];

			sh[j] = vec3(
				readProp(trip[0],row),
				readProp(trip[1],row),
				readProp(trip[2],row)
			);
		}

		gaussians.add(
			pos, scale, rot, color.w, color.xyz(), sh
		);
	}

	return GaussiansPacked(gaussians);
}

//-------------------------------------------//

static inline uint64_t ply_type_size(PlyType t) 
{
	switch (t) 
	{
	case PlyType::Int8:    return sizeof(int8_t);
	case PlyType::UInt8:   return sizeof(uint8_t);
	case PlyType::Int16:   return sizeof(int16_t);
	case PlyType::UInt16:  return sizeof(uint16_t);
	case PlyType::Int32:   return sizeof(int32_t);
	case PlyType::UInt32:  return sizeof(uint32_t);
	case PlyType::Float32: return sizeof(float);
	case PlyType::Float64: return sizeof(double);
	default:               return 0;
	}
}

static inline PlyType ply_type_parse(std::string_view name)
{
	if(name == "char"   || name == "int8"   ) return PlyType::Int8;
	if(name == "uchar"  || name == "uint8"  ) return PlyType::UInt8;
	if(name == "short"  || name == "int16"  ) return PlyType::Int16;
	if(name == "ushort" || name == "uint16" ) return PlyType::UInt16;
	if(name == "int"    || name == "int32"  ) return PlyType::Int32;
	if(name == "uint"   || name == "uint32" ) return PlyType::UInt32;
	if(name == "float"  || name == "float32") return PlyType::Float32;
	if(name == "double" || name == "float64") return PlyType::Float64;

	return PlyType::Unknown;
}

template<typename T> 
static inline T ply_read(PlyType type, const uint8_t* buf)
{
	switch (type) 
	{
	case PlyType::Int8:
	{
		int8_t val = *reinterpret_cast<const int8_t*>(buf);
		return static_cast<T>(val);
	}
	case PlyType::UInt8:
	{
		uint8_t val = *reinterpret_cast<const uint8_t*>(buf);
		return static_cast<T>(val);
	}
	case PlyType::Int16:   
	{
		int16_t val;
		std::memcpy(&val, buf, sizeof(int16_t));
		return static_cast<T>(val);
	}
	case PlyType::UInt16:   
	{
		uint16_t val;
		std::memcpy(&val, buf, sizeof(uint16_t));
		return static_cast<T>(val);
	}
	case PlyType::Int32:   
	{
		int32_t val;
		std::memcpy(&val, buf, sizeof(int32_t));
		return static_cast<T>(val);
	}
	case PlyType::UInt32:   
	{
		uint32_t val;
		std::memcpy(&val, buf, sizeof(uint32_t));
		return static_cast<T>(val);
	}
	case PlyType::Float32:   
	{
		float val;
		std::memcpy(&val, buf, sizeof(float));
		return static_cast<T>(val);
	}
	case PlyType::Float64:   
	{
		double val;
		std::memcpy(&val, buf, sizeof(double));
		return static_cast<T>(val);
	}
	default: 
		return static_cast<T>(0);
	}
}

}; //namespace ply
}; //namespace mgs