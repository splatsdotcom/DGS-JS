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

const std::string PLY_HEADER_START = "ply";
const std::string PLY_HEADER_END = "end_header\n";

static inline uint64_t ply_type_size(PlyType t);
static inline PlyType ply_type_parse(std::string_view name);

template<typename T> 
static inline T ply_read(PlyType type, const uint8_t* buf);

//-------------------------------------------//

GaussianGroup load(const std::vector<uint8_t>& buf)
{
	return load(static_cast<uint64_t>(buf.size()), buf.data());
}

GaussianGroup load(uint64_t size, const uint8_t* buf)
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

	std::string headerStr = std::string(reinterpret_cast<const char*>(buf), headerEnd);
	std::istringstream headerStream(headerStr);

	//read properties:
	//-----------------	
	uint64_t vertexCount = 0;
	
	std::unordered_map<std::string, std::pair<PlyType, uint64_t>> properties;
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
			
			properties[nameStr] = { t, offset };
		}
	}

	if(vertexCount == 0)
		return GaussianGroup(std::vector<GaussianPacked>());

	if(properties.find("x") == properties.end() || properties.find("y") == properties.end() || properties.find("z") == properties.end())
		throw std::runtime_error("PLY file did not contain gaussian positions!");

	bool hasScale   = properties.count("scale_0") && properties.count("scale_1") && properties.count("scale_2");
	bool hasOrient  = properties.count("rot_0")   && properties.count("rot_1")   && properties.count("rot_2")   && properties.count("rot_3");
	bool hasColor   = properties.count("f_dc_0")  && properties.count("f_dc_1")  && properties.count("f_dc_2");
	bool hasOpacity = properties.count("opacity");

	//detect spherical harmonics:
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
	}

	//validate data section:
	//-----------------	
	const uint8_t* dataStart = buf + headerEnd + PLY_HEADER_END.size();
	const uint8_t* dataEnd   = buf + size;
	if(dataStart + vertexCount * rowStride > dataEnd)
		throw std::runtime_error("Invalid PLY file - too small for specified data!");

	auto get = [&](const uint8_t* row, const char* name) -> float 
	{
		auto prop = properties[name];
		return ply_read<float>(prop.first, row + prop.second);
	};

	std::vector<GaussianPacked> gaussians;
	gaussians.reserve(vertexCount);

	for(uint64_t i = 0; i < vertexCount; i++) 
	{
		const uint8_t* row = dataStart + i * rowStride;

		vec3 pos = { get(row, "x"), get(row, "y"), get(row, "z") };
		vec3 scale = vec3(0.01f);
		quaternion rot = quaternion_identity();
		vec4 color = vec4(1.0f);

		if(hasScale) 
		{
			scale.x = std::exp(get(row, "scale_0"));
			scale.y = std::exp(get(row, "scale_1"));
			scale.z = std::exp(get(row, "scale_2"));
		}

		if(hasOrient)
		{
			float r0 = get(row, "rot_0");
			float r1 = get(row, "rot_1");
			float r2 = get(row, "rot_2");
			float r3 = get(row, "rot_3");

			float len = std::sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3);
			if(len > 1e-8f)
				rot = quaternion(r1 / len, r2 / len, r3 / len, r0 / len);
		}

		if(hasColor)
		{
			color.x = get(row, "f_dc_0");
			color.y = get(row, "f_dc_1");
			color.z = get(row, "f_dc_2");
		}

		if(hasOpacity)
			color.w = 1.0f / (1.0f + std::exp(-get(row, "opacity")));

		std::array<vec3, MGS_MAX_SH_COEFFS_REST> sh;

		for(uint32_t j = 0; j < restTriplets; j++)
		{
			std::string rName = "f_rest_" + std::to_string(j * 3 + 0);
			std::string gName = "f_rest_" + std::to_string(j * 3 + 1);
			std::string bName = "f_rest_" + std::to_string(j * 3 + 2);

			vec3 coeff(
				get(row, rName.c_str()),
				get(row, gName.c_str()),
				get(row, bName.c_str())
			);

			sh[j] = coeff;
		}

		Gaussian g(pos, scale, rot, color, sh);
		gaussians.push_back(g.pack());
	}

	return GaussianGroup(gaussians, degree);
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