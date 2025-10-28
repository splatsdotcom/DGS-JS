#include "mgs_gaussian.hpp"

#include <chrono>
#include <iostream>
#include <limits>
#include <algorithm>

namespace mgs
{

//-------------------------------------------//

static inline uint32_t align(uint32_t a, uint32_t b)
{
	return (a + b - 1) & ~(b - 1);
}

//-------------------------------------------//

Gaussians::Gaussians(uint32_t _shDegree, bool _dynamic) : 
	shDegree(_shDegree), dynamic(_dynamic)
{
	if(_shDegree > MGS_MAX_SH_DEGREE)
		throw std::invalid_argument("spherical haromics degree is too large");
}

void Gaussians::add(const vec3& mean, const vec3& scale, const quaternion& rotation, 
                    float opacity, const vec3& color, const std::vector<vec3>& sh,
                    const vec3& velocity, float tMean, float tStdev)
{
	if(sh.size() != (shDegree + 1) * (shDegree + 1) - 1)
		throw std::invalid_argument("incorrect number of spherical haromics provided");

	means.push_back(mean);
	scales.push_back(scale);
	rotations.push_back(rotation);
	opacities.push_back(opacity);
	colors.push_back(color);

	for(uint32_t i = 0; i < sh.size(); i++)
		shs.push_back(sh[i]);

	if(dynamic)
	{
		velocities.push_back(velocity);
		tMeans.push_back(tMean);
		tStdevs.push_back(tStdev);
	}

	count++;
}

GaussiansPacked::GaussiansPacked(const Gaussians& gaussians) :
	shDegree(gaussians.shDegree), dynamic(gaussians.dynamic), count(gaussians.count)
{
	uint32_t numShCoeff = (shDegree + 1) * (shDegree + 1) - 1;
	
	//compute min and max for color/sh:
	//-----------------	
	colorMin =  INFINITY;
	colorMax = -INFINITY;
	shMin =  INFINITY;
	shMax = -INFINITY;

	for(uint32_t i = 0; i < count; i++)
	{
		colorMin = std::min(colorMin, gaussians.colors[i].r);
		colorMin = std::min(colorMin, gaussians.colors[i].g);
		colorMin = std::min(colorMin, gaussians.colors[i].b);

		colorMax = std::max(colorMax, gaussians.colors[i].r);
		colorMax = std::max(colorMax, gaussians.colors[i].g);
		colorMax = std::max(colorMax, gaussians.colors[i].b);

		for(uint32_t j = 0; j < numShCoeff; j++)
		{
			shMin = std::min(shMin, gaussians.shs[i * numShCoeff + j].r);
			shMin = std::min(shMin, gaussians.shs[i * numShCoeff + j].g);
			shMin = std::min(shMin, gaussians.shs[i * numShCoeff + j].b);

			shMax = std::max(shMax, gaussians.shs[i * numShCoeff + j].r);
			shMax = std::max(shMax, gaussians.shs[i * numShCoeff + j].g);
			shMax = std::max(shMax, gaussians.shs[i * numShCoeff + j].b);
		}
	}

	//pack each gaussian:
	//-----------------
	float colorScale = 1.0f / (colorMax - colorMin);
	float shScale = 1.0f / (shMax - shMin);

	means.resize(count);
	covariances.resize(count * 6);
	opacities.resize(align(count, 4));
	colors.resize(align(count * 3, 2));
	shs.resize(align(count * numShCoeff * 3, 4));

	if(dynamic)
		velocities.resize(count);
	
	for(uint32_t i = 0; i < count; i++)
	{
		//mean:
		means[i] = vec4(
			gaussians.means[i], 
			dynamic ? gaussians.tMeans[i] : 0.0f
		);

		//covariance
		mat4 M = qm::scale(gaussians.scales[i]) * quaternion_to_mat4(gaussians.rotations[i]);
		float covariance[6] = {
			M[0][0] * M[0][0] + M[0][1] * M[0][1] + M[0][2] * M[0][2],
			M[0][0] * M[1][0] + M[0][1] * M[1][1] + M[0][2] * M[1][2],
			M[0][0] * M[2][0] + M[0][1] * M[2][1] + M[0][2] * M[2][2],
			M[1][0] * M[1][0] + M[1][1] * M[1][1] + M[1][2] * M[1][2],
			M[1][0] * M[2][0] + M[1][1] * M[2][1] + M[1][2] * M[2][2],
			M[2][0] * M[2][0] + M[2][1] * M[2][1] + M[2][2] * M[2][2]
		};

		for(uint32_t j = 0; j < 6; j++)
			covariances[i * 6 + j] = 4.0f * covariance[j];

		//opacity
		opacities[i] = (uint8_t)(gaussians.opacities[i] * UINT8_MAX);

		//color
		colors[i * 3 + 0] = (uint16_t)((gaussians.colors[i].r - colorMin) * colorScale * UINT16_MAX);
		colors[i * 3 + 1] = (uint16_t)((gaussians.colors[i].g - colorMin) * colorScale * UINT16_MAX);
		colors[i * 3 + 2] = (uint16_t)((gaussians.colors[i].b - colorMin) * colorScale * UINT16_MAX);

		//sh
		for(uint32_t j = 0; j < numShCoeff; j++)
		{
			uint32_t idx = (i * numShCoeff + j) * 3;
			shs[idx + 0] = (uint8_t)((gaussians.shs[i * numShCoeff + j].r - shMin) * shScale * UINT8_MAX);
			shs[idx + 1] = (uint8_t)((gaussians.shs[i * numShCoeff + j].g - shMin) * shScale * UINT8_MAX);
			shs[idx + 2] = (uint8_t)((gaussians.shs[i * numShCoeff + j].b - shMin) * shScale * UINT8_MAX);
		}

		//velocity:
		if(dynamic)
			velocities[i] = vec4(gaussians.velocities[i], gaussians.tStdevs[i]);
	}
}

GaussiansPacked::GaussiansPacked(const std::vector<uint8_t>& serialized)
{
	const uint8_t* ptr = serialized.data();
	size_t remaining = serialized.size();

	auto read = [&](void* dst, size_t size) {
		if(remaining < size) 
			throw std::runtime_error("GaussiansPacked: truncated input");

		std::memcpy(dst, ptr, size);
		ptr += size;
		remaining -= size;
	};

	//read header:
	//-----------------
	read(&shDegree, sizeof(uint32_t));
	read(&dynamic, sizeof(bool));
	read(&count, sizeof(uint32_t));
	read(&colorMax, sizeof(float));
	read(&colorMin, sizeof(float));
	read(&shMax, sizeof(float));
	read(&shMin, sizeof(float));

	uint32_t numShCoeff = (shDegree + 1) * (shDegree + 1) - 1;
	
	//read data:
	//-----------------
	auto read_vector = [&](auto& v, size_t numElems) {
		using T = typename std::remove_reference<decltype(v[0])>::type;
		v.resize(numElems);
		size_t bytes = numElems * sizeof(T);
		read(v.data(), bytes);
	};

	read_vector(means, count);
	read_vector(covariances, count * 6);
	read_vector(opacities, align(count, 4));
	read_vector(colors, align(count * 3, 2));
	read_vector(shs, align(count * numShCoeff * 3, 4));
	if(dynamic)
		read_vector(velocities, count);

	//validate:
	//-----------------
	if(remaining != 0)
		throw std::runtime_error("GaussiansPacked: extra bytes at end of input");
}

std::vector<uint8_t> GaussiansPacked::serialize() const
{
	std::vector<uint8_t> data;

	//write header:
	//-----------------
	auto append = [&](const void* src, size_t size) {
		size_t offset = data.size();
		data.resize(offset + size);
		std::memcpy(data.data() + offset, src, size);
	};

	append(&shDegree, sizeof(shDegree));
	append(&dynamic, sizeof(dynamic));
	append(&count, sizeof(count));
	append(&colorMax, sizeof(colorMax));
	append(&colorMin, sizeof(colorMin));
	append(&shMax, sizeof(shMax));
	append(&shMin, sizeof(shMin));

	//write data:
	//-----------------
	auto append_vector = [&](auto const& v) {
		if(!v.empty())
			append(v.data(), v.size() * sizeof(v[0]));
	};

	append_vector(means);
	append_vector(covariances);
	append_vector(opacities);
	append_vector(colors);
	append_vector(shs);
	if(dynamic)
		append_vector(velocities);

	return data;
}

}; //namespace mgs